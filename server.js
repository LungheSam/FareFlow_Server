const express = require('express');
const cors = require('cors');
const africastalking = require('africastalking');
const emailjs = require('@emailjs/nodejs');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc, addDoc, updateDoc, arrayUnion, collection } = require('firebase/firestore');
const { getDatabase, ref, get: getRTDB } = require('firebase/database'); // Ensure you import RTDB functions

require('dotenv').config();


const app = express();
const PORT = 5000;

// Constants
// const FARE_AMOUNT = 2000;
// const MIN_BALANCE = 2000;
// const busPlateNumber= 'UAZ-123'
// Firebase configuration
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
  databaseURL: process.env.FIREBASE_DATABASE_URL
};

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const dbRT = getDatabase(firebaseApp); // RTDB instance
// Middleware
app.use(cors());
app.use(express.json());

// EmailJS setup
emailjs.init({
  publicKey: process.env.EMAILJS_PUBLIC_KEY,
  privateKey: process.env.EMAILJS_PRIVATE_KEY,
});

// Africa's Talking setup
const at = africastalking({
  apiKey: process.env.AT_API_KEY,
  username: process.env.AT_USERNAME,
});
const sms = at.SMS;

// Welcome Message Endpoint
app.post('/send-welcome-message', async (req, res) => {
  const { email, phone, firstName, lastName, cardUID, password } = req.body;

  const message = `Hello ${firstName},\nThank you for registering on FareFlow.\nEmail: ${email}\nCardUID: ${cardUID}\nPassword: ${password}`;

  try {
    // Check if user already exists
    const userRef = doc(db, 'users', cardUID);
    const userSnap = await getDoc(userRef);
    
    if (userSnap.exists()) {
      return res.status(400).json({ 
        success: false, 
        error: 'User with this card UID already exists' 
      });
    }

    // Create new user in Firestore
    await setDoc(userRef, {
      firstName,
      lastName,
      email,
      phone,
      cardUID,
      password,
      balance: 0,
      trips: [],
      createdAt: new Date()
    });

    // Send Email using EmailJS
    await emailjs.send(
      process.env.EMAILJS_SERVICE_ID,
      process.env.EMAILJS_TEMPLATE_ID,
      {
        to_email: email,
        subject: 'Welcome to FareFlow',
        message: message,
        email: email,
        first_name: firstName,
        card_uid: cardUID,
        password: password
      }
    );
    console.log("Email Sent Successfully to "+email);

    // Send SMS using Africa's Talking
    const result = await sms.send({
      to: [phone],
      message: message,
    });
    console.log('SMS sent:', result);
    res.status(200).json({ success: true, message: 'Registration successful! Email and SMS sent.' });

  } catch (error) {
    console.error('Notification error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/process-fare', async (req, res) => {
  const { cardUID } = req.body;

  try {
    // 1. Find user by card UID
    const userRef = doc(db, 'users', cardUID);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found',
        hardwareCode: 'USER_NOT_FOUND'
      });
    }

    const user = userSnap.data();

    if (user.blocked) {
      return res.status(400).json({
        status: 'error',
        message: 'User Blocked',
        hardwareCode: 'USER_BLOCKED'
      });
    }

    // 2. Get Bus Info from RTDB
    const busPlateNumber = 'UAZ-123'; // Make this dynamic later
    const busRTRef = ref(dbRT, `buses/${busPlateNumber}`);
    const busRTSnap = await getRTDB(busRTRef);

    if (!busRTSnap.exists()) {
      return res.status(404).json({
        status: 'error',
        message: 'Bus not found in RTDB',
        hardwareCode: 'BUS_NOT_FOUND'
      });
    }

    const busRTData = busRTSnap.val();

    if (!busRTData.status) {
      return res.status(403).json({
        status: 'error',
        message: 'Bus is currently inactive',
        hardwareCode: 'BUS_INACTIVE'
      });
    }

    const route = busRTData.route;
    if (route?.type === 'dynamic') {
      return res.json({
        status: 'info',
        message: 'Welcome aboard. Dynamic pricing not implemented yet.',
        hardwareCode: 'DYNAMIC_ROUTE_WELCOME TO THE BUS'
      });
    }

    // Proceed with fixed route fare deduction
    const FARE_AMOUNT = route.fareAmount || 1500;
    const MIN_BALANCE = 500;

    if (user.balance < MIN_BALANCE) {
      const result = {
        status: 'error',
        message: `FareFlow Payment Unsuccessful\nLow balance. Minimum required: ${MIN_BALANCE} UGX\nThank you for using FareFlow`,
        hardwareCode: 'LOW_BALANCE'
      };
      await sms.send({ to: [user.phone], message: result.message });
      await emailjs.send(
            process.env.EMAILJS_SERVICE_ID,
            process.env.EMAILJS_TEMPLATE_PAYMENT_ID,
            {
              first_name: user.firstName,
              transaction_id: `${cardUID}-${Date.now()}`,
              transaction_date: new Date().toLocaleString(),
              card_uid: cardUID,
              fare_amount: FARE_AMOUNT,
              previous_balance: user.balance,
              current_balance: newBalance,
              email: user.email,
              status_title:'Payment Failed',
              status_message:'Unfortunately, your fare payment could not be processed. Low balance. Minimum required: '+{MIN_BALANCE}+'UGX\nPlease ensure you have sufficient balance or contact support.'
            }
        );
      return res.status(400).json(result);
    }

    if (user.balance < FARE_AMOUNT) {
      const result = {
        status: 'error',
        message: `FareFlow Payment Unsuccessful\nInsufficient balance for the fare. Needed: ${FARE_AMOUNT} UGX\nThank you for using FareFlow`,
        hardwareCode: 'INSUFFICIENT_FARE'
      };
      await sms.send({ to: [user.phone], message: result.message });
      await emailjs.send(
          process.env.EMAILJS_SERVICE_ID,
          process.env.EMAILJS_TEMPLATE_PAYMENT_ID,
          {
            first_name: user.firstName,
            transaction_id: `${cardUID}-${Date.now()}`,
            transaction_date: new Date().toLocaleString(),
            card_uid: cardUID,
            fare_amount: FARE_AMOUNT,
            previous_balance: user.balance,
            current_balance: newBalance,
            email: user.email,
            status_title:'Payment Failed',
            status_message:'Unfortunately, your fare payment could not be processed. Insufficient balance for the fare. Needed:'+{FARE_AMOUNT}+'UGX.\nPlease ensure you have sufficient balance or contact support.'
          }
        );
      return res.status(400).json(result);
    }

    // Deduct fare
    const newBalance = user.balance - FARE_AMOUNT;
    const transactionRecord = {
      amount: FARE_AMOUNT,
      date: new Date().toISOString(),
      type: 'payment'
    };

    await updateDoc(userRef, {
      balance: newBalance,
      transactions: arrayUnion(transactionRecord)
    });

    await addDoc(collection(db, 'transactions'), {
      amount: FARE_AMOUNT,
      busId: 'Bus 1',
      busPlateNumber,
      cardUID,
      passengerName: `${user.firstName} ${user.lastName || ''}`.trim(),
      timestamp: new Date()
    });

    // Update Firestore bus earnings...
    const busRef = doc(db, 'buses', busPlateNumber);
    const busSnap = await getDoc(busRef);

    if (busSnap.exists()) {
      const busData = busSnap.data();
      const today = new Date();
      const dayStr = today.toISOString().split('T')[0]; // e.g., "2025-05-26"
      const monthStr = today.toLocaleString('default', { month: 'short' }); // e.g., "May"

      // Update weekly earnings
      let weeklyEarnings = [...(busData.weeklyEarnings || [])];
      const weeklyIndex = weeklyEarnings.findIndex(entry => entry.day === dayStr);
      if (weeklyIndex >= 0) {
        weeklyEarnings[weeklyIndex].amount += FARE_AMOUNT;
      } else {
        weeklyEarnings.push({ day: dayStr, amount: FARE_AMOUNT });
      }

      // Update monthly earnings
      let monthlyEarnings = [...(busData.monthlyEarnings || [])];
      const monthlyIndex = monthlyEarnings.findIndex(entry => entry.month === monthStr);
      if (monthlyIndex >= 0) {
        monthlyEarnings[monthlyIndex].amount += FARE_AMOUNT;
      } else {
        monthlyEarnings.push({ month: monthStr, amount: FARE_AMOUNT });
      }

      // Update total earnings
      const totalEarnings = (busData.totalEarnings || 0) + FARE_AMOUNT;

      // Apply updates
      await updateDoc(busRef, {
        weeklyEarnings,
        monthlyEarnings,
        totalEarnings
      });
    }

    const smsMessage = `FareFlow Payment Successful\n\nA fare of ${FARE_AMOUNT} UGX has been deducted from your account\nRoute: ${busRTData.route.departure} to ${busRTData.route.destination}\nYour new balance is ${newBalance} UGX.\n\nThank you for riding with us.\nThank you for using FareFlow`;
    await sms.send({ to: [user.phone], message: smsMessage });

    await emailjs.send(
      process.env.EMAILJS_SERVICE_ID,
      process.env.EMAILJS_TEMPLATE_PAYMENT_ID,
      {
        first_name: user.firstName,
        transaction_id: `${cardUID}-${Date.now()}`,
        transaction_date: new Date().toLocaleString(),
        card_uid: cardUID,
        fare_amount: FARE_AMOUNT,
        previous_balance: user.balance,
        current_balance: newBalance,
        email: user.email,
        status_title: 'Success',
        status_message: 'Your fare payment has been processed successfully.'
      }
    );

    return res.json({
      status: 'success',
      message: 'Fare processed successfully',
      newBalance,
      hardwareCode: 'PAYMENT_SUCCESS'
    });

  } catch (error) {
    console.error('Payment processing error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error',
      hardwareCode: 'SERVER_ERROR'
    });
  }
});


app.post('/notify-balance-load', async (req, res) => {
  const { cardUID, amount, newBalance, email, phone, firstName } = req.body;

  try {
    const transactionId = `${cardUID}-${Date.now()}`;

    //1. Send SMS
    await sms.send({
      to: [phone],
      message: `\n------\nFareFlow TopUp Successful\n------\nHello ${firstName}, Your FareFlow account ${cardUID} has been topped up with ${amount} UGX.\nNew Balance: ${newBalance} UGX.\nThank you for using FareFlow...`
    });

    // 2. Send Email
    await emailjs.send(
      process.env.EMAILJS_SERVICE_ID,
      process.env.EMAILJS_TEMPLATE_PAYMENT_ID,
      {
        transaction_id: transactionId,
        transaction_date: new Date().toLocaleString(),
        card_uid: cardUID,
        amount,
        current_balance: newBalance,
        email,
        first_name: firstName,
        status_title: 'Balance Top-Up Successful',
        status_message: `You have successfully added ${amount} UGX to your FareFlow account.\nThank you for using FareFlow....`
      }
    );

    res.json({ status: 'success', message: 'Notifications sent' });
  } catch (error) {
    console.error('Notification error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to send notifications' });
  }
});

// Get User Balance Endpoint
app.get('/user-balance/:cardUID', async (req, res) => {
  try {
    const userRef = doc(db, 'users', req.params.cardUID);
    const userSnap = await getDoc(userRef);
    
    if (!userSnap.exists()) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ balance: userSnap.data().balance });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add Funds Endpoint
app.post('/add-funds', async (req, res) => {
  const { cardUID, amount } = req.body;
  
  try {
    const userRef = doc(db, 'users', cardUID);
    const userSnap = await getDoc(userRef);
    
    if (!userSnap.exists()) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const currentBalance = userSnap.data().balance;
    const newBalance = currentBalance + Number(amount);
    
    await updateDoc(userRef, {
      balance: newBalance
    });
    
    res.json({ 
      message: `Added ${amount} UGX to account`,
      newBalance: newBalance 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});