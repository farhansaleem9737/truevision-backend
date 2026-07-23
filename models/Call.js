// Backend/models/Call.js
//
// Call-history log. One row per placed call (voice or video). The live media
// is peer-to-peer WebRTC — the server only relays signalling (see socket.js)
// and records this lightweight audit row so the app can show a call log and
// "Missed call" entries.
//
// `callId` is generated client-side by the CALLER and echoed on every
// signalling message, so both peers and the server share one id per call.

const mongoose = require('mongoose');

const callSchema = new mongoose.Schema({
  // Client-generated id shared across all signalling for this call.
  callId: { type: String, required: true, unique: true, index: true },

  caller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  callee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  mode: { type: String, enum: ['audio', 'video'], default: 'audio' },

  // Lifecycle:
  //   ringing   — invite delivered, awaiting an answer
  //   answered  — callee accepted (media negotiating / connected)
  //   ended     — normal hang-up after being answered
  //   declined  — callee actively rejected
  //   missed    — callee offline or never answered (caller cancelled / timeout)
  //   busy      — callee was already on another call
  status: {
    type:    String,
    enum:    ['ringing', 'answered', 'ended', 'declined', 'missed', 'busy'],
    default: 'ringing',
    index:   true,
  },

  answeredAt:  { type: Date, default: null },
  endedAt:     { type: Date, default: null },
  durationSec: { type: Number, default: 0 },
}, { timestamps: true });

// Call log per user, newest first (either side of the call).
callSchema.index({ caller: 1, createdAt: -1 });
callSchema.index({ callee: 1, createdAt: -1 });

module.exports = mongoose.model('Call', callSchema);
