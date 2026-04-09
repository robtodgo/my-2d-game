const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const MAP_SIZE = 32;
const worldBlocks = [];
for (let x = 0; x < MAP_SIZE; x++) {
    worldBlocks[x] = [];
    for (let z = 0; z < MAP_SIZE; z++) worldBlocks[x][z] = { type: 'grass' };
}
worldBlocks[5][5] = { type: 'stone' };
worldBlocks[6][5] = { type: 'stone' };
worldBlocks[5][6] = { type: 'stone' };

const players = new Map();
const admins = new Set();
const ADMIN_PASSWORD = 'secret123';

function createItem(id, count=1) {
    const items = { 'sword': { name:'Меч', emoji:'🗡️', damage:25 }, 'pickaxe': { name:'Кирка', emoji:'⛏️', damage:10 }, 'apple': { name:'Яблоко', emoji:'🍎', heal:20 } };
    return { id, count, ...(items[id] || { name:id, emoji:'📦' }) };
}

io.on('connection', (socket) => {
    console.log(`+ ${socket.id}`);
    socket.on('login', (nickname, cb) => {
        nickname = nickname.trim().substring(0,12);
        if ([...players.values()].some(p => p.nickname === nickname)) return cb({ ok: false, msg: 'Ник занят' });
        const player = { id: socket.id, nickname, x:2, y:2, z:2, hp:100, maxHp:100, inventory: [ createItem('sword'), createItem('pickaxe'), createItem('apple',5), ...Array(6).fill(null) ], selectedSlot:0 };
        players.set(socket.id, player);
        cb({ ok: true, self: player, players: Object.fromEntries(players), world: worldBlocks });
        socket.broadcast.emit('player joined', player);
    });
    socket.on('move', (data) => {
        const p = players.get(socket.id); if (!p) return;
        p.x = data.x; p.y = data.y; p.z = data.z;
        socket.broadcast.emit('player moved', { id: socket.id, x: p.x, y: p.y, z: p.z });
    });
    socket.on('break block', (data) => {
        const { x, z } = data;
        if (x>=0 && x<MAP_SIZE && z>=0 && z<MAP_SIZE && worldBlocks[x][z]) {
            worldBlocks[x][z] = null;
            io.emit('block update', { x, z, block: null });
        }
    });
    socket.on('chat message', (msg) => {
        const p = players.get(socket.id); if (!p) return;
        if (!msg.startsWith('/')) return io.emit('chat message', { sender: p.nickname, text: msg });
        const args = msg.slice(1).split(' '), cmd = args[0].toLowerCase();
        if (cmd === 'help') socket.emit('chat message', { sender:'📚', text:'/help, /tp <ник>, /op <пароль>' });
        else if (cmd === 'tp' && args[1]) {
            const target = [...players.values()].find(pl => pl.nickname === args[1]);
            if (target) { p.x = target.x; p.y = target.y; p.z = target.z; io.emit('player moved', { id: socket.id, x: p.x, y: p.y, z: p.z }); }
        } else if (cmd === 'op' && args[1] === ADMIN_PASSWORD) { admins.add(socket.id); socket.emit('admin', true); }
    });
    socket.on('disconnect', () => {
        if (players.has(socket.id)) { players.delete(socket.id); io.emit('player left', socket.id); }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on ${PORT}`));