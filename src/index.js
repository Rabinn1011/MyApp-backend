const express   = require('express');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
app.use(express.json());

// Fix 9 — rate limiters
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 20,                    // 20 attempts per window
  message: { error: 'Too many attempts, please try again later' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute
  max: 60,                    // 60 requests per minute
  message: { error: 'Too many requests' },
});

// Apply auth limiter to login/register only
app.use('/auth', authLimiter);

// Apply general limiter to everything else
app.use('/livekit', apiLimiter);
app.use('/payment', apiLimiter);

app.use('/auth',    require('./routes/auth'));
app.use('/livekit', require('./routes/livekit'));
app.use('/payment', require('./routes/payment'));

// Fix 1 — restore kick timers after restart
const db = require('./db');
const { restoreTimersFromDB } = require('./services/kickScheduler');
restoreTimersFromDB(db);

const { LIVEKIT_ENABLED } = require('./config/livekit');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
  console.log(
    LIVEKIT_ENABLED
      ? '[livekit] Real LiveKit API enabled'
      : '[livekit] Stub mode — set LIVEKIT_ENABLED=true in .env to connect LiveKit Cloud',
  );
});