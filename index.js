const express = require('express')
const app = express()
const cors = require('cors')
require('dotenv').config()
const stripe = require('stripe')(process.env.STRIPE_SECRET);
const port = process.env.PORT || 3000



app.use(express.json())
// This middleware:
// Sees Content-Type: application/json in the request header
// Reads the raw JSON string from the request body
// Runs JSON.parse() on it
// Attaches the result to req.body.
// So req.body becomes a plain JavaScript object — ready to use.
app.use(cors())



const admin = require("firebase-admin")
// const serviceAccount = require("./zapshift-firebase-adminsdk.json")  // it(private key/service account key) gives my server full admin access to my Firebase project that i created in console. It tells Firebase - This server is trusted. Give it full access. I need the fr-admin here to authenticate my users.

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});




function generateTrackingId(parcelName) {
  const formattedName = parcelName.replace(/\s+/g, "-");
  const randomDigits = Math.floor(100000 + Math.random() * 900000); // 6-digit number
  return `${formattedName}-${randomDigits}`;
}



const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization

  if (!token) {
    return res.status(401).send({ message: 'you are unauthorize..' })
  }

  try {
    const idToken = token.split(' ')[1]
    const decoded = await admin.auth().verifyIdToken(idToken) // Firebase Admin SDK checks: "Is this a real, valid Firebase ID token?"
    req.decoded_email = decoded.email // Now I'm adding the email to the Express request object
    next()
  }
  catch (err) {
    return res.status(401).send({ message: 'you are unauthorize..' })
  }
}



// MongoClient - the main tool used to connect to your MongoDB database
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb')

// database connection string
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.oj9o1yk.mongodb.net/?appName=Cluster0`

// it as creating a "messenger = client" that knows where my database is (uri) and how to talk to it.
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
})

// async function run() {
//   try {
//     // Connect the client to the server.	(optional starting in v4.7)
//     await client.connect();




let dbReady = client.connect().then(() => {
  console.log('Mongo connected');
});

// middleware: wait for connection before handling any request
app.use(async (req, res, next) => {
  try {
    await dbReady;
    next();
  } catch (err) {
    res.status(500).send({ message: 'DB connection failed' });
  }
});


const db = client.db("zap_shift_db")
const userCollection = db.collection('users')
const parcelCollection = db.collection('parcels')
const paymentCollection = db.collection('payments')
const riderCollection = db.collection('riders')
const trackingCollection = db.collection('tracking')


const verifyAdmin = async (req, res, next) => {
  const email = req.decoded_email
  const query = { email }

  const user = await userCollection.findOne(query)

  if (!user || user.role !== 'admin') {
    return res.status(403).send({ message: 'forbidden access.' })
  }
  next()
}


const logTracking = async ({ parcelName, trackingId, status }) => {
  const log = {
    parcelName,
    trackingId,
    status,
    details: status.replace(/[_-]/g, ' '),
    createdAt: new Date()
  }
  const result = await trackingCollection.insertOne(log)
  return result
}




// api's from here //................................!!
// user related
app.get('/all-users', verifyToken, verifyAdmin, async (req, res) => {
  const searchText = req.query.searchText
  const query = {}

  if (searchText) {
    query.$or = [
      { displayName: { $regex: searchText, $options: 'i' } },
      { email: { $regex: searchText, $options: 'i' } }
    ]
  }

  const cursor = userCollection.find(query).sort({ createdAt: -1 })
  const result = await cursor.toArray()
  res.send(result)

}) //Done

app.get('/user-role/:email', verifyToken, async (req, res) => {
  // console.log('it is hitted....')
  const email = req.params.email
  const query = { email }
  const user = await userCollection.findOne(query)
  res.send({ role: user?.role || '' })
}) // Done

app.post('/create-users', async (req, res) => {
  const userInfo = req.body
  userInfo.role = 'user'
  userInfo.createdAt = new Date()

  const email = userInfo.email
  const existUser = await userCollection.findOne({ email })
  if (existUser) {
    return res.send({ message: 'user exist.' })
  }

  const result = await userCollection.insertOne(userInfo)
  res.send(result)
}) //Done

app.patch('/make-admin/:id', verifyToken, verifyAdmin, async (req, res) => {
  const id = req.params.id
  const roleInfo = req.body
  const query = { _id: new ObjectId(id) }

  const updateAdmin = {
    $set: {
      role: roleInfo.role
    }
  }

  const result = await userCollection.updateOne(query, updateAdmin)
  res.send(result)
}) // Done

app.get('/user-dashboard-stats', async (req, res) => {

  const email = req.query.email

  const pipeline = [
    {
      $match: {
        senderEmail: email
      }
    },

    {
      $group: {
        _id: null,

        totalParcels: {
          $sum: 1
        },

        totalSpent: {
          $sum: {
            $cond: [
              {
                $ne: [
                  { $type: '$deliveryStatus' },
                  "missing"
                ] // here $ne returns string->true (the type of deliStus) if deliveryStatus exist otherwise it returns missing->false.
              },
              '$cost', 0
            ]
          }
        },

        delivered: {
          $sum: {
            $cond: [
              { $eq: ['$deliveryStatus', 'marked_as_delivered'] },
              1,
              0
            ]
          }
        },

        inTransit: {
          $sum: {
            $cond: [
              {
                $in: [
                  '$deliveryStatus',
                  ['driver_assigned', 'rider_arriving', 'marked_as_picked_up']
                ]
              },
              1,
              0
            ]
          }
        },

        amount_pending: {
          $sum: {
            $cond: [
              {
                $ne: [
                  { $type: "$deliveryStatus" },
                  "missing"
                ]
              },
              0, 1
            ]
          }
        },
      }

    }
  ]

  const result = await parcelCollection.aggregate(pipeline).toArray()
  res.send(result)
})





// rider's api
app.get('/get-riders', async (req, res) => {
  const { status, district, workStatus } = req.query
  const query = {}

  if (status) {
    query.status = status
  }
  if (district) {
    query.riderDistrict = district
  }
  if (workStatus) {
    query.workStatus = workStatus
  }

  const cursor = riderCollection.find(query)
  const result = await cursor.toArray()
  res.send(result)
}) //Done

app.post('/create-rider', async (req, res) => {
  const riderInfo = req.body
  const existingRider = await riderCollection.findOne({
    riderEmail: riderInfo.riderEmail
  })
  if (existingRider) {
    return res.status(409).send({ message: 'Rider already exists' })
  }
  riderInfo.status = 'pending'
  riderInfo.createdAt = new Date()
  const result = await riderCollection.insertOne(riderInfo)
  res.send(result)
}) // Done

app.patch('/approve-rider/:id', verifyToken, verifyAdmin, async (req, res) => {
  const status = req.body.status
  const id = req.params.id
  const query = { _id: new ObjectId(id) }

  let result // ✅ declare here

  if (status === 'approved') {
    const updateRider = {
      $set: {
        status: status,
        workStatus: 'available',
      }
    }
    result = await riderCollection.updateOne(query, updateRider)

    const email = req.body.ridersEmail
    const userQuery = { email }
    const updateUser = {
      $set: {
        role: 'rider'
      }
    }
    await userCollection.updateOne(userQuery, updateUser)
  }

  else if (status === 'rejected') {
    const updateRider = {
      $set: {
        status: status,
        workStatus: 'rider not approved',
      }
    }
    result = await riderCollection.updateOne(query, updateRider)

    const email = req.body.ridersEmail
    const userQuery = { email }
    const updateUser = {
      $set: {
        role: 'user'
      }
    }
    await userCollection.updateOne(userQuery, updateUser)
  }

  res.send(result)
}) //Done

app.delete('/delete-rider/:id', verifyToken, verifyAdmin, async (req, res) => {
  const id = req.params.id
  const query = { _id: new ObjectId(id) }
  const result = await riderCollection.deleteOne(query)
  res.json(result)
}) //Done





// parcel related -- 
app.get('/my-parcels', async (req, res) => {

  const query = {}
  // --> dynamically add filters to this object in if statements.
  const { email, deli_statuss } = req.query // req.query is a object
  // --> Get the query parameters from the URL

  if (email) {
    query.senderEmail = email
  }

  if (deli_statuss) {
    query.deliveryStatus = deli_statuss
  }

  const cursor = await parcelCollection.find(query).toArray()
  res.send(cursor)

}) // Done

app.get('/one-parcel/:id', async (req, res) => {
  //  URL path
  const id = req.params.id
  const query = { _id: new ObjectId(id) }
  // The resulting object looks like: { _id: ObjectId('507f1f77bcf86cd799439011')}. Means - find the document whose _id matches this ObjectId. 
  const result = await parcelCollection.findOne(query)
  res.send(result)
})

app.get('/rider-parcels', async (req, res) => {
  const { riderEmail, deliveryStatus } = req.query
  const query = {}

  if (riderEmail) {
    query.rider_email = riderEmail
    query.deliveryStatus = { $nin: ['marked_as_delivered'] }
  }

  if (deliveryStatus) {
    query.deliveryStatus = deliveryStatus
  }

  const cursor = parcelCollection.find(query)
  const result = await cursor.toArray()
  res.send(result)

}) // Done

app.post('/post-parcels', async (req, res) => {
  const parcel = req.body

  const trackingId = generateTrackingId(parcel.parcelName)
  parcel.createdAt = new Date()
  parcel.trackingId = trackingId

  logTracking({ parcelName: parcel.parcelName, trackingId: trackingId, status: 'parcel_created' })

  const result = await parcelCollection.insertOne(parcel)
  res.send(result)
}) // Done

app.patch('/update-parcel/:id', async (req, res) => {
  const { rId, rName, rEmail, parcelName, trackingId } = req.body

  const query = { _id: new ObjectId(req.params.id) }
  const riderQuery = { _id: new ObjectId(rId) }

  const parcelUpdatedDoc = {
    $set: {
      deliveryStatus: 'driver_assigned',
      rider_id: rId,
      rider_name: rName,
      rider_email: rEmail
    }
  }

  const parelUpdateResult = await parcelCollection.updateOne(query, parcelUpdatedDoc)

  logTracking({ parcelName: parcelName, trackingId: trackingId, status: 'driver_assigned' })

  const riderUpdatedDoc = {
    $set: {
      workStatus: 'in_delivery'
    }
  }
  const riderUpdateResult = await riderCollection.updateOne(riderQuery, riderUpdatedDoc)

  res.send({ f: riderUpdateResult, g: parelUpdateResult })
}) // Done

app.patch('/parcel/:id/status', async (req, res) => {
  const { deliveryStatus, riderId, parcelName, trackingId } = req.body
  const query = { _id: new ObjectId(req.params.id) }

  const updatedDoc = {
    $set: {
      deliveryStatus: deliveryStatus
    }
  }

  await logTracking({ parcelName: parcelName, trackingId: trackingId, status: deliveryStatus })

  if (deliveryStatus === 'marked_as_delivered') {
    const query = { _id: new ObjectId(riderId) }

    const updateRider = {
      $set: {
        workStatus: 'available'
      }
    }

    const riderResult = await riderCollection.updateOne(query, updateRider)
  }

  const result = await parcelCollection.updateOne(query, updatedDoc)
  res.send(result)
})

app.patch('/parcel-reject/:id', async (req, res) => {

  const { rider_id } = req.body

  const query = { _id: new ObjectId(req.params.id) }
  const riderQuery = { _id: new ObjectId(rider_id) }

  const updateDoc = {
    $set: {
      deliveryStatus: 'amount_paid'
    },
    $unset: {
      rider_name: "",
      rider_id: "",
      rider_email: "",
    }
  }

  const riderUpdateDoc = {
    $set: {
      workStatus: 'available'
    }
  }

  const result = await parcelCollection.updateOne(query, updateDoc)
  const riderResult = await riderCollection.updateOne(riderQuery, riderUpdateDoc)

  res.send(result)
}) // Done

app.delete('/delete-parcels/:id', async (req, res) => {
  const id = req.params.id
  const query = { _id: new ObjectId(id) }
  const result = await parcelCollection.deleteOne(query)
  res.send(result)
}) // Done






// Payment related
app.post('/create-checkout-session', async (req, res) => {
  const paymentInfo = req.body
  const amount = parseInt(paymentInfo.cost) * 100

  // first i created a session for the user to pay, the interface.
  const session = await stripe.checkout.sessions.create({

    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: amount,
          product_data: {
            name: paymentInfo.parcelName,
          }
        },
        quantity: 1,
      },
    ],

    customer_email: paymentInfo.senderEmail,
    mode: 'payment',
    metadata: {
      parcelId: paymentInfo._id,
      parcelName: paymentInfo.parcelName,
      trackingId: paymentInfo.trackingId,
    },

    success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-successs?session_id={CHECKOUT_SESSION_ID}`,
    // CHECKOUT_SESSION_ID -- Stripe replaces this automatically with the actual Checkout Session ID after successful payment or creating a session.
    cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-canceled`,

  })

  // then i send that session's url to visit stripe payment session.
  res.send({ url: session.url })

}) // Done

// in this api(bellow) i am actually seeking the status of the payment after a successfull payment by taking the param (session_id ) from the success url. and then i am updating the document with a new field paymrntStatus.  
app.patch('/payment-success', async (req, res) => {
  const session_id = req.query.session_id
  const session = await stripe.checkout.sessions.retrieve(session_id)
  // here i am retriving the full payment session by using the session_id.
  // console.log(session)
  // res.send(session)

  const trackinggId = session.metadata.trackingId
  const transactionnId = session.payment_intent

  const query = { transactionId: transactionnId }
  const existPayment = await paymentCollection.findOne(query)
  if (existPayment) {
    return res.send({ message: 'already exist..', trackingId: trackinggId, transactionId: transactionnId })
  }

  const queryTracking = { trackinggId: trackinggId }
  const existTracking = await trackingCollection.findOne(queryTracking)
  if (!existTracking) {
    const parcelName = session.metadata.parcelName
    logTracking({ parcelName: parcelName, trackingId: trackinggId, status: 'amount_paid' })
  }

  if (session.payment_status === 'paid') {
    const id = session.metadata.parcelId
    const query = { _id: new ObjectId(id) }
    const update = {
      $set: {
        paymentStatus: 'paid',
        deliveryStatus: 'amount_paid',
      }
    }
    const result = await parcelCollection.updateOne(query, update)
    // res.send( result)

    const payment = {
      amount: session.amount_total / 100,
      currency: session.currency,
      customerEmail: session.customer_email,
      parcelId: session.metadata.parcelId,
      parcelName: session.metadata.parcelName,
      transactionId: session.payment_intent,
      paymentStatus: session.payment_status,
      trackingId: trackinggId,
      paidAt: new Date()
    }

    if (session.payment_status === 'paid') {
      const resultPayment = await paymentCollection.insertOne(payment)
      res.send({
        success: true,
        resultPayment: resultPayment,
        trackingId: trackinggId,
        transactionId: transactionnId,
      })
    }
  }
  else {
    res.send({ session: false })
  }
})  // Done 

app.get('/see-all-payments', verifyToken, async (req, res) => {
  // console.log('full req -- ', req)
  const email = req.decoded_email // req.query.email - if i am sending the email as query,
  const query = {}
  if (email) {
    query.customerEmail = email

    if (email != req.decoded_email) {
      return res.status(403).send({ message: 'forbidden access' })
    }
  }
  const cursor = paymentCollection.find(query)
  const result = await cursor.toArray()
  res.send(result)
}) //Done





// ttracking related API's
app.get('/tracking/:trackingId', async (req, res) => {
  const id = req.params.trackingId
  const query = { trackingId: id }
  const result = await trackingCollection.find(query).toArray()
  res.send(result)
})




// Send a ping to confirm a successful connection
// await client.db("admin").command({ ping: 1 });
// console.log("Pinged your deployment. You successfully connected to MongoDB!");
//   }

//   finally {
//     // Ensures that the client will close when you finish/error
//     // await client.close();
//   }
// }

// run().catch(console.dir);


app.get('/', (req, res) => {
  res.send('Zap is Shifting........!')
})

// app.listen(port, () => {
//   console.log(`Example app listening on port ${port}`)
// })


module.exports = app;

if (process.env.NODE_ENV !== 'production') {
  app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
  });
}