const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Configure CORS for Socket.io and Express
app.use(cors());

const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173", // Your React app's origin
    methods: ["GET", "POST"]
  }
});

// --- Server-Side State Management ---
let currentPoll = null; // { id: string, question: string, options: { text: string, isCorrect: boolean }[], duration: number, startTime: number }
let pollResults = {};   // { optionId: voteCount, ... }
let pollTimer = null;   // setInterval ID
let timeLeft = 0;       // seconds remaining

// { socketId: { role: 'teacher'|'student', name?: string, hasAnswered?: boolean, connected: boolean }, ... }
let connectedClients = {};

// { pollId: { question: string, options: [], results: {}, duration: number, timestamp: number }, ... }
let pollHistory = [];

const PORT = process.env.PORT || 3001;

// --- Helper Functions ---
function broadcastPollState() {
  io.emit('pollStateUpdate', {
    currentPoll,
    pollResults,
    timeLeft,
    totalStudents: Object.values(connectedClients).filter(c => c.role === 'student').length,
    studentsAnswered: Object.values(connectedClients).filter(c => c.role === 'student' && c.hasAnswered).length
  });
}

function endCurrentPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  if (currentPoll) {
    // Add to history
    pollHistory.push({
      id: currentPoll.id,
      question: currentPoll.question,
      options: currentPoll.options,
      results: { ...pollResults }, // Deep copy results
      duration: currentPoll.duration,
      timestamp: Date.now()
    });
  }

  // Notify all clients that poll has ended and send final results
  io.emit('pollEnded', {
    finalResults: pollResults,
    pollId: currentPoll ? currentPoll.id : null
  });

  // Reset current poll state
  currentPoll = null;
  pollResults = {};
  timeLeft = 0;
  
  // Reset answered status for all students
  for (const socketId in connectedClients) {
    if (connectedClients[socketId].role === 'student') {
      connectedClients[socketId].hasAnswered = false;
    }
  }

  broadcastPollState(); // Update state for teachers after ending
  console.log('Current poll ended and state reset.');
}

// --- Socket.io Connection Handling ---
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // --- Client Registration ---
  socket.on('registerClient', ({ role, name }) => {
    connectedClients[socket.id] = { role, name, hasAnswered: false, connected: true };
    console.log(`${role} ${name ? `(${name}) ` : ''}registered with ID: ${socket.id}`);

    // Send current poll state to newly connected client
    socket.emit('initialPollState', {
      currentPoll,
      pollResults,
      timeLeft,
      totalStudents: Object.values(connectedClients).filter(c => c.role === 'student').length,
      studentsAnswered: Object.values(connectedClients).filter(c => c.role === 'student' && c.hasAnswered).length,
      pollHistory // Send history to teachers for now, can be optimized later
    });
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    if (connectedClients[socket.id]) {
      console.log(`${connectedClients[socket.id].role} ${connectedClients[socket.id].name || ''} disconnected.`);
      delete connectedClients[socket.id];

      // Check if poll needs to end if all current students have answered or no students are left
      const totalStudents = Object.values(connectedClients).filter(c => c.role === 'student' && c.connected).length;
      const studentsAnswered = Object.values(connectedClients).filter(c => c.role === 'student' && c.hasAnswered && c.connected).length;

      if (currentPoll && (totalStudents === 0 || (totalStudents > 0 && studentsAnswered === totalStudents))) {
        console.log('All active students have answered or no students left. Ending poll.');
        endCurrentPoll();
      } else {
        broadcastPollState(); // Update teacher dashboards if student count changes
      }
    }
  });

  // --- Teacher Events ---
  socket.on('createPoll', ({ question, options, duration }) => {
    // Only allow if no poll is active
    if (currentPoll) {
      socket.emit('error', 'A poll is already active. Please end it first.');
      return;
    }

    const pollId = `poll-${Date.now()}`;
    currentPoll = {
      id: pollId,
      question,
      options: options.map((opt, index) => ({ id: `${pollId}-opt-${index}`, text: opt.text, isCorrect: opt.isCorrect })),
      duration,
      startTime: Date.now(),
    };
    
    // Initialize poll results
    pollResults = currentPoll.options.reduce((acc, opt) => { acc[opt.id] = 0; return acc; }, {});
    timeLeft = duration;

    // Reset answered status for all students for new poll
    for (const clientId in connectedClients) {
      if (connectedClients[clientId].role === 'student') {
        connectedClients[clientId].hasAnswered = false;
      }
    }

    console.log(`New poll created by teacher ${socket.id}: ${question}`);
    io.emit('newPoll', currentPoll); // Send new poll to all clients

    // Start countdown timer
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      timeLeft--;
      if (timeLeft <= 0) {
        console.log('Poll timer ended.');
        endCurrentPoll();
      } else {
        broadcastPollState(); // Update timer for teachers/students
      }
    }, 1000);

    broadcastPollState(); // Initial state update for teachers
  });

  socket.on('endPoll', () => {
    if (!currentPoll) {
      socket.emit('error', 'No active poll to end.');
      return;
    }
    console.log(`Teacher ${socket.id} manually ended the poll.`);
    endCurrentPoll();
  });

  // --- Student Events ---
  socket.on('submitAnswer', ({ pollId, optionId }) => {
    console.log(`[SubmitAnswer] Received from ${socket.id}. Poll ID: ${pollId}, Option ID: ${optionId}`);
    if (!currentPoll || currentPoll.id !== pollId) {
      socket.emit('error', 'Invalid poll or poll is not active.');
      console.log(`[SubmitAnswer] Poll not active or invalid. Socket: ${socket.id}`);
      return;
    }

    console.log(`[SubmitAnswer] Before check, hasAnswered for ${socket.id}: ${connectedClients[socket.id]?.hasAnswered}`);
    if (connectedClients[socket.id] && connectedClients[socket.id].hasAnswered) {
      socket.emit('error', 'You have already answered this poll.');
      console.log(`[SubmitAnswer] Already answered detected for ${socket.id}.`);
      return;
    }

    // Mark student as answered immediately to prevent multiple submissions
    if (connectedClients[socket.id]) {
      connectedClients[socket.id].hasAnswered = true;
      console.log(`[SubmitAnswer] hasAnswered set to TRUE for ${socket.id}.`);
    }

    // Increment vote count
    if (pollResults.hasOwnProperty(optionId)) {
      pollResults[optionId]++;
      console.log(`[SubmitAnswer] Vote incremented for option ${optionId}. New count: ${pollResults[optionId]}`);
    } else {
      // Should not happen if pollResults initialized correctly
      console.warn(`Attempted to vote for unknown optionId: ${optionId}`);
      pollResults[optionId] = 1; 
      console.log(`[SubmitAnswer] Initializing vote for option ${optionId}. Count: ${pollResults[optionId]}`);
    }

    console.log(`Student ${connectedClients[socket.id]?.name || socket.id} submitted answer for option ${optionId}.`);
    broadcastPollState(); // Update live results for everyone

    // Check if all students have answered
    const totalStudents = Object.values(connectedClients).filter(c => c.role === 'student' && c.connected).length;
    const studentsAnswered = Object.values(connectedClients).filter(c => c.role === 'student' && c.hasAnswered && c.connected).length;

    if (totalStudents > 0 && studentsAnswered === totalStudents) {
      console.log('All active students have answered. Ending poll early.');
      endCurrentPoll();
    }
  });

  // Event for requesting poll history (e.g., when teacher visits the page)
  socket.on('requestPollHistory', () => {
    socket.emit('pollHistoryUpdate', pollHistory);
  });
});

app.get('/', (req, res) => {
  res.send('Polling System Backend is running!');
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 