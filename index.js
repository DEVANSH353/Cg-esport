const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');

// Initialize Firebase Admin
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.applicationDefault()
    });
}

const db = admin.firestore();
const app = express();
app.use(express.json());

// --- UTILS ---
const verifyCashfreeSignature = (payload, signature, secretKey) => {
    const message = Object.keys(payload)
        .sort()
        .filter(key => key !== 'signature')
        .map(key => `${key}${payload[key]}`)
        .join('');
    const expectedSignature = crypto
        .createHmac('sha256', secretKey)
        .update(message)
        .digest('base64');
    return expectedSignature === signature;
};

// --- ENDPOINTS ---

/**
 * POST /webhook/cashfree
 */
app.post('/webhook/cashfree', async (req, res) => {
    const signature = req.headers['x-cf-signature'];
    const secretKey = process.env.CASHFREE_SECRET_KEY;
    const { orderId, orderAmount, txStatus, referenceId } = req.body;

    if (!verifyCashfreeSignature(req.body, signature, secretKey)) {
        return res.status(401).send('Invalid signature');
    }

    const txRef = db.collection('transactions').doc(orderId);

    try {
        await db.runTransaction(async (t) => {
            const txDoc = await t.get(txRef);
            if (!txDoc.exists) throw new Error('Order not found');
            
            const txData = txDoc.data();
            if (txData.status !== 'PENDING') return; // Idempotency check

            if (txStatus === 'SUCCESS') {
                const userRef = db.collection('users').doc(txData.userId);
                const userDoc = await t.get(userRef);
                const currentWallet = userDoc.data().wallet || 0;

                t.update(userRef, { wallet: currentWallet + parseFloat(orderAmount) });
                t.update(txRef, { status: 'SUCCESS', cfReferenceId: referenceId });
            } else {
                t.update(txRef, { status: 'FAILED' });
            }
        });
        res.status(200).send('OK');
    } catch (error) {
        res.status(500).send(error.message);
    }
});

/**
 * POST /auth/signup
 */
app.post('/auth/signup', async (req, res) => {
    const { uid, username, email, referralCode } = req.body;
    if (!uid || !username || !email) return res.status(400).send('Missing fields');

    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();

    if (userDoc.exists) return res.status(200).json(userDoc.data());

    const newUser = {
        uid,
        username,
        email,
        wallet: 0,
        totalXP: 0,
        joinedMatches: [],
        referralCode: Math.random().toString(36).substring(2, 8).toUpperCase(),
        referredBy: referralCode || null,
        matchesPlayed: 0,
        totalKills: 0,
        dailyStreak: 0,
        isVIP: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await userRef.set(newUser);
    res.status(201).json(newUser);
});

/**
 * POST /match/join
 */
app.post('/match/join', async (req, res) => {
    const { matchId, gameUids, userUid } = req.body; // userUid from auth context normally
    if (![1, 2, 4].includes(gameUids?.length)) return res.status(400).send('Invalid team size');

    const matchRef = db.collection('matches').doc(matchId);
    const userRef = db.collection('users').doc(userUid);
    const teamRef = db.collection('matches').doc(matchId).collection('teams').doc(userUid);

    try {
        await db.runTransaction(async (t) => {
            const match = await t.get(matchRef);
            const user = await t.get(userRef);
            
            if (!match.exists || match.data().status !== 'upcoming') throw new Error('Match unavailable');
            if (match.data().joinedCount + gameUids.length > match.data().maxPlayers) throw new Error('Match full');
            if (user.data().wallet < match.data().entryFee) throw new Error('Insufficient balance');
            
            const teamDoc = await t.get(teamRef);
            if (teamDoc.exists) throw new Error('Already joined');

            // Global check for gameUids in this match
            const existingTeams = await t.get(db.collection('matches').doc(matchId).collection('teams'));
            const allUids = [];
            existingTeams.forEach(doc => allUids.push(...doc.data().gameUids));
            if (gameUids.some(id => allUids.includes(id))) throw new Error('Duplicate Game UID in match');

            t.update(userRef, { 
                wallet: user.data().wallet - match.data().entryFee,
                joinedMatches: admin.firestore.FieldValue.arrayUnion(matchId)
            });
            
            t.update(matchRef, { joinedCount: admin.firestore.FieldValue.increment(gameUids.length) });
            
            t.set(teamRef, {
                ownerUid: userUid,
                ownerUsername: user.data().username,
                gameUids: gameUids
            });

            t.set(db.collection('transactions').doc(), {
                userId: userUid,
                type: 'MATCH_JOIN',
                amount: match.data().entryFee,
                status: 'SUCCESS',
                matchId,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        });
        res.status(200).send('Joined successfully');
    } catch (e) {
        res.status(400).send(e.message);
    }
});

/**
 * POST /rewards/daily
 */
app.post('/rewards/daily', async (req, res) => {
    const { userUid } = req.body;
    const userRef = db.collection('users').doc(userUid);

    try {
        await db.runTransaction(async (t) => {
            const user = await t.get(userRef);
            const data = user.data();
            const now = Date.now();
            const lastClaim = data.lastDailyClaim?.toMillis() || 0;

            if (now - lastClaim < 24 * 60 * 60 * 1000) throw new Error('Already claimed today');

            t.update(userRef, {
                wallet: admin.firestore.FieldValue.increment(10),
                dailyStreak: admin.firestore.FieldValue.increment(1),
                lastDailyClaim: admin.firestore.FieldValue.serverTimestamp()
            });

            t.set(db.collection('transactions').doc(), {
                userId: userUid,
                type: 'DAILY_REWARD',
                amount: 10,
                status: 'SUCCESS',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        });
        res.status(200).send('Reward claimed');
    } catch (e) {
        res.status(400).send(e.message);
    }
});

/**
 * POST /wallet/withdraw
 */
app.post('/wallet/withdraw', async (req, res) => {
    const { userUid, amount, upiId } = req.body;
    const userRef = db.collection('users').doc(userUid);

    try {
        await db.runTransaction(async (t) => {
            const user = await t.get(userRef);
            if (user.data().wallet < amount) throw new Error('Insufficient balance');

            t.update(userRef, { wallet: admin.firestore.FieldValue.increment(-amount) });
            
            const txRef = db.collection('transactions').doc();
            t.set(txRef, {
                userId: userUid,
                type: 'WITHDRAWAL',
                amount,
                upiId,
                status: 'PENDING',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        });
        res.status(200).send('Withdrawal initiated');
    } catch (e) {
        res.status(400).send(e.message);
    }
});

/**
 * POST /admin/match/distribute
 */
app.post('/admin/match/distribute', async (req, res) => {
    const { matchId, gameUid, rank, kills } = req.body;
    const matchRef = db.collection('matches').doc(matchId);

    try {
        await db.runTransaction(async (t) => {
            const matchDoc = await t.get(matchRef);
            if (!matchDoc.exists || matchDoc.data().prizeDistributed) throw new Error('Already distributed or invalid match');

            const teamsSnap = await t.get(db.collection('matches').doc(matchId).collection('teams').where('gameUids', 'array-contains', gameUid));
            if (teamsSnap.empty) throw new Error('Team not found for gameUid');
            
            const teamData = teamsSnap.docs[0].data();
            const ownerUid = teamData.ownerUid;
            const userRef = db.collection('users').doc(ownerUid);
            const userDoc = await t.get(userRef);

            const matchData = matchDoc.data();
            const rankPrize = matchData.rankPrizes[rank] || 0;
            const totalPrize = (kills * matchData.perKillRate) + rankPrize;
            const xpGained = (kills * 10) + (rankPrize > 0 ? 50 : 10);

            t.update(userRef, {
                wallet: admin.firestore.FieldValue.increment(totalPrize),
                totalXP: admin.firestore.FieldValue.increment(xpGained),
                totalKills: admin.firestore.FieldValue.increment(kills),
                matchesPlayed: admin.firestore.FieldValue.increment(1)
            });

            t.set(db.collection('transactions').doc(), {
                userId: ownerUid,
                type: 'PRIZE_DISTRIBUTION',
                amount: totalPrize,
                matchId,
                status: 'SUCCESS',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            // Note: In a real scenario, prizeDistributed is usually per-user or per-match.
            // Requirement says "prizeDistributed flag" blocks duplicate.
            t.update(matchRef, { prizeDistributed: true });
        });
        res.status(200).send('Prizes distributed');
    } catch (e) {
        res.status(400).send(e.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
