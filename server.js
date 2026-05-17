const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Load Database
let database = {};
try {
  database = JSON.parse(fs.readFileSync('database.json', 'utf8'));
  console.log('Database loaded successfully.');
} catch (error) {
  console.error('Error loading database:', error);
}

let whoIsThisDatabase = [];
try {
  whoIsThisDatabase = JSON.parse(fs.readFileSync('who_is_this.json', 'utf8'));
  console.log('Who Is This Database loaded successfully.');
} catch (error) {
  console.error('Error loading who_is_this database:', error);
}

const getRandomQuestion = () => {
  if (database && database['جميع_الأسئلة'] && database['جميع_الأسئلة'].length > 0) {
    const questions = database['جميع_الأسئلة'];
    const randomIndex = Math.floor(Math.random() * questions.length);
    return questions[randomIndex];
  }
  // Fallback if db is not formatted as expected
  return {
    "س": "ما هو المنتخب الفائز بكأس العالم 2022؟",
    "خيارات": ["الأرجنتين", "فرنسا", "البرازيل", "المغرب"],
    "الجواب": 0
  };
};

const rooms = {};

const generateRoomCode = () => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('createRoom', ({ mode, playerName }, callback) => {
    const roomCode = generateRoomCode();
    let maxPlayers = 2;
    if (mode === '2v2') maxPlayers = 4;
    if (mode === '4v4') maxPlayers = 8;

    rooms[roomCode] = {
      code: roomCode,
      mode,
      maxPlayers,
      players: [{ id: socket.id, name: playerName, score: 0 }],
      status: 'waiting', 
      currentRound: 0, // 1 to 4
      totalRounds: 4,
      // Round 1 specific state (Fibbage)
      phase: '', // 'input_fake', 'choose', 'results'
      currentQuestion: null,
      fakeAnswers: {}, // { playerId: answerText }
      choices: [], // Shuffled options: [{ text: "...", ownerId: "..." or null for real answer }]
      playerChoices: {} // { playerId: chosenOptionText }
    };

    socket.join(roomCode);
    callback({ success: true, roomCode });
    io.to(roomCode).emit('roomUpdated', rooms[roomCode]);
  });

  socket.on('joinRoom', ({ roomCode, playerName }, callback) => {
    const room = rooms[roomCode];
    if (!room) return callback({ success: false, message: 'الغرفة غير موجودة' });
    if (room.players.length >= room.maxPlayers) return callback({ success: false, message: 'الغرفة ممتلئة' });
    if (room.status !== 'waiting') return callback({ success: false, message: 'اللعبة بدأت بالفعل' });

    room.players.push({ id: socket.id, name: playerName, score: 0 });
    socket.join(roomCode);
    callback({ success: true });
    
    if (room.players.length === room.maxPlayers) {
      startRound(room, 1);
    }
    io.to(roomCode).emit('roomUpdated', room);
  });

  const startRound = (room, roundNumber) => {
    room.status = 'playing';
    room.currentRound = roundNumber;
    
    // For Phase 1, we assume all rounds use the Fibbage logic temporarily for testing
    // Later we will switch logic based on roundNumber
    const q = getRandomQuestion();
    room.currentQuestion = {
      text: q['س'],
      correctAnswer: q['خيارات'][q['الجواب']]
    };
    room.phase = 'input_fake';
    room.fakeAnswers = {};
    room.playerChoices = {};
    room.choices = [];
  };

  socket.on('submitFakeAnswer', ({ roomCode, answer }) => {
    const room = rooms[roomCode];
    if (!room || room.status !== 'playing' || room.phase !== 'input_fake') return;

    // Check if player is in room
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    room.fakeAnswers[socket.id] = answer.trim();

    // Check if all players submitted
    if (Object.keys(room.fakeAnswers).length === room.players.length) {
      // Proceed to choosing phase
      room.phase = 'choose';
      
      // Build choices list
      let options = [{ text: room.currentQuestion.correctAnswer, ownerId: null }];
      for (const [pId, ans] of Object.entries(room.fakeAnswers)) {
        // Prevent duplicate texts
        if (!options.find(o => o.text.toLowerCase() === ans.toLowerCase())) {
          options.push({ text: ans, ownerId: pId });
        }
      }
      
      // Shuffle options
      room.choices = options.sort(() => Math.random() - 0.5);
    }

    io.to(roomCode).emit('roomUpdated', room);
  });

  socket.on('submitChoice', ({ roomCode, chosenText }) => {
    const room = rooms[roomCode];
    if (!room || room.status !== 'playing' || room.phase !== 'choose') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    // A player cannot choose their own fake answer
    if (room.fakeAnswers[socket.id] && room.fakeAnswers[socket.id].toLowerCase() === chosenText.toLowerCase()) {
      return; // Ignore invalid choice
    }

    room.playerChoices[socket.id] = chosenText;

    // Check if everyone has chosen
    if (Object.keys(room.playerChoices).length === room.players.length) {
      room.phase = 'results';
      
      // Calculate scores
      for (const [pId, choice] of Object.entries(room.playerChoices)) {
        const pIndex = room.players.findIndex(p => p.id === pId);
        
        if (choice === room.currentQuestion.correctAnswer) {
          // +1000 for correct answer
          room.players[pIndex].score += 1000;
        } else {
          // Find who wrote this fake answer
          const fakeOwner = room.choices.find(c => c.text === choice);
          if (fakeOwner && fakeOwner.ownerId) {
            const ownerIndex = room.players.findIndex(p => p.id === fakeOwner.ownerId);
            if (ownerIndex !== -1) {
              // +500 to the person who tricked them
              room.players[ownerIndex].score += 500;
            }
          }
        }
      }

      // Automatically go to next round after 10 seconds
      setTimeout(() => {
        if (room.currentRound >= room.totalRounds) {
          room.status = 'finished';
        } else {
          startRound(room, room.currentRound + 1);
        }
        io.to(roomCode).emit('roomUpdated', room);
      }, 10000);
    }

    io.to(roomCode).emit('roomUpdated', room);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);
        if (room.players.length === 0) {
          delete rooms[roomCode];
        } else {
          io.to(roomCode).emit('roomUpdated', room);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
