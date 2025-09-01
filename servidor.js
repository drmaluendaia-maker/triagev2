// 1. Configuración del servidor
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const os = require('os');
const fs = require('fs');
const open = require('open');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = 3000;
const DB_FILE = 'pacientes.json';
const USERS_FILE = 'usuarios.json';
const PRESETS_FILE = 'presets.json';

const ADMIN_MASTER_PASS = "superadmin";
let users = [];

app.use(express.static(__dirname));
app.get('/', (req, res) => res.redirect('/index.html'));

let patients = [];
let attendedHistory = [];
let observationPresets = [];
let isEmergency = false;
let currentlyCalled = null;
const triageOrder = { 'rojo': 1, 'naranja': 2, 'amarillo': 3, 'verde': 4, 'azul': 5 };

// --- Funciones de guardado y carga de datos ---
const saveData = () => { fs.writeFile(DB_FILE, JSON.stringify({ patients, attendedHistory }, null, 2), err => { if (err) console.error("Error al guardar pacientes:", err); }); };
const saveUsers = () => { fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), err => { if (err) console.error("Error al guardar usuarios:", err); }); };
const savePresets = () => { fs.writeFile(PRESETS_FILE, JSON.stringify(observationPresets, null, 2), err => { if (err) console.error("Error al guardar presets:", err); }); };

const loadData = () => {
    try {
        if (fs.existsSync(DB_FILE)) { const data = JSON.parse(fs.readFileSync(DB_FILE)); patients = data.patients || []; attendedHistory = data.attendedHistory || []; }
        if (fs.existsSync(USERS_FILE)) { users = JSON.parse(fs.readFileSync(USERS_FILE)); } else { users = [{ user: "admin", pass: "admin2025", role: "registro", fullName: "Admin Enfermería" }, { user: "medico1", pass: "med1", role: "medico", fullName: "Dr. House" }, { user: "stats", pass: "stats123", role: "estadisticas", fullName: "Jefe de Guardia" }]; }
        users.forEach(u => { if (!u.token) u.token = crypto.randomBytes(16).toString('hex'); });
        saveUsers();
        if (fs.existsSync(PRESETS_FILE)) { observationPresets = JSON.parse(fs.readFileSync(PRESETS_FILE)); } else { observationPresets = [ { text: "Parada cardiorrespiratoria", level: "rojo" }, { text: "Dolor torácico", level: "naranja" }, { text: "Tos con mocos", level: "verde" }]; savePresets(); }
        console.log("Datos cargados correctamente.");
    } catch (err) { console.error("Error al cargar datos:", err); }
};

// --- Funciones de utilidad ---
const sortPatients = () => { patients.sort((a, b) => { if (a.ordenTriage !== b.ordenTriage) return a.ordenTriage - b.ordenTriage; return a.horaLlegada - b.horaLlegada; }); };
const getNurseShift = (date) => { const hour = date.getHours(); const minutes = date.getMinutes(); const time = hour + minutes / 60; if (time >= 6.5 && time < 14.5) return "Mañana"; if (time >= 14.5 && time < 22.5) return "Tarde"; return "Noche"; };
const getDoctorGuard = (date) => { let guardDate = new Date(date); if (date.getHours() < 8) { guardDate.setDate(guardDate.getDate() - 1); } const dayName = guardDate.toLocaleDateString('es-ES', { weekday: 'long' }); const dayMonth = guardDate.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' }); return `Guardia del ${dayName.charAt(0).toUpperCase() + dayName.slice(1)} ${dayMonth}`; };

// --- Lógica del Socket ---
io.on('connection', (socket) => {
    let isAuthenticated = false; let userRole = null; let currentUser = null;
    
    // --- Autenticación ---
    const authenticateSocket = (user) => {
        isAuthenticated = true;
        userRole = user.role;
        currentUser = user; // currentUser es el objeto de usuario completo
        socket.emit('auth_success', user); // Enviar el objeto de usuario completo al cliente
        if (user.role === 'registro' || user.role === 'admin') {
            socket.emit('presets_update', observationPresets);
        }
    };
    socket.on('authenticate_user', ({ user, pass }) => { const foundUser = users.find(u => u.user === user && u.pass === pass); if (foundUser) authenticateSocket(foundUser); else socket.emit('auth_fail'); });
    socket.on('authenticate_token', (token) => { const foundUser = users.find(u => u.token === token); if (foundUser) authenticateSocket(foundUser); else { socket.emit('auth_fail'); } });
    
    // --- Emisiones iniciales al cliente ---
    socket.emit('update_patient_list', patients); 
    socket.emit('emergency_status_update', isEmergency); 
    socket.emit('update_call', currentlyCalled);
    
    // --- Lógica de Administración ---
    const sendFullUserList = (targetSocket) => { const displayUsers = [{ user: "superadmin", pass: ADMIN_MASTER_PASS, role: "admin", fullName: "Administrador Principal" }, ...users]; targetSocket.emit('users_update', displayUsers); };
    socket.on('admin_login', ({pass, remember}) => { if (pass === ADMIN_MASTER_PASS) { isAuthenticated = true; userRole = 'admin'; socket.join('admin_room'); const token = remember ? crypto.randomBytes(16).toString('hex') : null; socket.emit('admin_auth_success', {token}); sendFullUserList(socket); socket.emit('presets_update', observationPresets); } else { socket.emit('auth_fail'); } });
    socket.on('get_users', () => { if (isAuthenticated && userRole === 'admin') sendFullUserList(socket); });
    socket.on('add_user', (newUser) => { if (isAuthenticated && userRole === 'admin' && newUser.user && newUser.pass && newUser.fullName && newUser.role) { if (!users.some(u => u.user === newUser.user) && newUser.user !== 'superadmin') { newUser.token = crypto.randomBytes(16).toString('hex'); users.push(newUser); saveUsers(); sendFullUserList(io.to('admin_room')); sendFullUserList(socket); } } });
    socket.on('delete_user', (username) => { if (isAuthenticated && userRole === 'admin' && username !== 'superadmin') { users = users.filter(u => u.user !== username); saveUsers(); sendFullUserList(io.to('admin_room')); sendFullUserList(socket); } });
    socket.on('edit_user', ({ username, newFullName, newPassword }) => { if (isAuthenticated && userRole === 'admin' && username !== 'superadmin') { const userIndex = users.findIndex(u => u.user === username); if (userIndex > -1) { users[userIndex].fullName = newFullName; users[userIndex].pass = newPassword; saveUsers(); sendFullUserList(io.to('admin_room')); sendFullUserList(socket); } } });
    socket.on('reset_patient_data', () => { if (isAuthenticated && userRole === 'admin') { patients = []; attendedHistory = []; saveData(); io.emit('update_patient_list', patients); socket.emit('reset_success'); } });

    // --- Lógica de Presets/Observaciones ---
    socket.on('search_patient_history', ({ query, role }) => { if (!isAuthenticated) return; const normalizedQuery = query.toUpperCase().trim(); let results = attendedHistory.filter(p => (p.dni && p.dni.includes(normalizedQuery)) || p.nombre.toUpperCase().includes(normalizedQuery)).sort((a, b) => b.attendedAt - a.attendedAt); if (role === 'registro') { results = results.map(p => { const { doctorNotes, ...patientData } = p; return patientData; }); } socket.emit('patient_history_result', results); });
    const hasPresetPermission = () => isAuthenticated && (userRole === 'admin' || userRole === 'registro');
    socket.on('add_preset', (newPreset) => { if (hasPresetPermission() && newPreset.text && newPreset.level && !observationPresets.some(p => p.text === newPreset.text)) { observationPresets.push(newPreset); savePresets(); io.emit('presets_update', observationPresets); } });
    socket.on('delete_preset', (presetText) => { if (hasPresetPermission() && presetText) { observationPresets = observationPresets.filter(p => p.text !== presetText); savePresets(); io.emit('presets_update', observationPresets); } });
    socket.on('edit_preset', ({ oldText, newText, newLevel }) => { if (hasPresetPermission()) { const presetIndex = observationPresets.findIndex(p => p.text === oldText); if (presetIndex > -1) { observationPresets[presetIndex] = { text: newText, level: newLevel }; savePresets(); io.emit('presets_update', observationPresets); } } });

    // --- Lógica principal de Pacientes (protegida por autenticación) ---
    const setupProtectedEvents = () => {
        const events = {
            'register_patient': (newPatient) => { if (userRole !== 'registro') return; newPatient.registeredBy = currentUser.user; newPatient.shift = getNurseShift(new Date(newPatient.horaLlegada)); patients.push(newPatient); sortPatients(); io.emit('new_patient_notification', { patient: newPatient, patientCount: patients.length }); },
            'mark_as_attended': ({ patientId, attendedByUsername }) => { const patientIndex = patients.findIndex(p => p.id === patientId); if (patientIndex > -1) { const [attendedPatient] = patients.splice(patientIndex, 1); attendedPatient.attendedAt = Date.now(); const attendingUser = users.find(u => u.user === attendedByUsername); attendedPatient.attendedBy = attendingUser ? attendingUser.fullName : attendedByUsername; attendedPatient.guardDay = getDoctorGuard(new Date(attendedPatient.attendedAt)); attendedHistory.push(attendedPatient); } },
            'update_patient_level': ({ id, newLevel }) => { if (userRole !== 'registro') return; const p = patients.find(p => p.id === id); if (p) { p.nivelTriage = newLevel; p.ordenTriage = triageOrder[newLevel]; sortPatients(); } },
            'add_nurse_evolution': ({ id, note }) => { if (userRole !== 'registro') return; const patient = patients.find(p => p.id === id); if (patient) { if (!patient.nurseEvolutions) patient.nurseEvolutions = []; patient.nurseEvolutions.push({ text: note, user: currentUser.fullName, timestamp: Date.now() }); } },
            'call_patient': ({ id, consultorio }) => { if (userRole !== 'medico') return; const currentlyAttending = patients.find(pt => pt.doctor_user === currentUser.user && pt.status === 'atendiendo'); if (currentlyAttending) { currentlyAttending.status = currentlyAttending.previousStatus || 'en_espera'; delete currentlyAttending.consultorio; delete currentlyAttending.doctor_user; delete currentlyAttending.doctor_name; } const p = patients.find(p => p.id === id); if (p) { p.previousStatus = p.status; p.status = 'atendiendo'; p.consultorio = consultorio; p.doctor_user = currentUser.user; p.doctor_name = currentUser.fullName; currentlyCalled = { nombre: p.nombre, consultorio }; io.emit('update_call', currentlyCalled); setTimeout(() => { currentlyCalled = null; io.emit('update_call', null); }, 20000); } },
            'update_patient_status': ({ id, status }) => { if (userRole !== 'medico') return; const p = patients.find(p => p.id === id); if (p) { p.status = status; if (status === 'ausente' || status === 'pre_internacion') { delete p.consultorio; } sortPatients(); } },
            'start_emergency': () => { isEmergency = true; io.emit('emergency_status_update', isEmergency); },
            'end_emergency': () => { isEmergency = false; io.emit('emergency_status_update', isEmergency); },
            'add_doctor_note': ({ id, note }) => { if (userRole !== 'medico') return; const patient = patients.find(p => p.id === id); if (patient) { if (!patient.doctorNotes) patient.doctorNotes = []; patient.doctorNotes.push({ text: note, doctor: currentUser.fullName, timestamp: Date.now() }); } },
            'continue_care': (patientId) => { if (userRole !== 'medico') return; const historyIndex = attendedHistory.findIndex(p => p.id === patientId); if (historyIndex > -1) { const [patientToReactivate] = attendedHistory.splice(historyIndex, 1); patientToReactivate.status = 'pre_internacion'; delete patientToReactivate.consultorio; delete patientToReactivate.doctor_user; delete patientToReactivate.doctor_name; patients.push(patientToReactivate); sortPatients(); } }
        };
        for (const eventName in events) { socket.on(eventName, (data) => { if (!isAuthenticated) return; events[eventName](data); saveData(); io.emit('update_patient_list', patients); }); }
    };
    setupProtectedEvents();

    // --- Lógica de Historial y Estadísticas ---
    socket.on('get_attended_history', () => { if (!isAuthenticated) return; let historyToSend = []; if (userRole === 'registro') { const currentShift = getNurseShift(new Date()); historyToSend = attendedHistory.filter(p => p.registeredBy === currentUser.user && p.shift === currentShift); } else if (userRole === 'medico') { const currentGuard = getDoctorGuard(new Date()); historyToSend = attendedHistory.filter(p => (p.attendedBy === currentUser.fullName) && p.guardDay === currentGuard); } else if (userRole === 'estadisticas') { const now = new Date(); const dayOfWeek = now.getDay(); const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); const weekStart = new Date(now.setDate(diff)).setHours(0, 0, 0, 0); historyToSend = attendedHistory.filter(p => p.attendedAt >= weekStart); } socket.emit('attended_history_update', historyToSend.sort((a,b) => b.attendedAt - a.attendedAt)); });
    socket.on('get_stats', () => { if (!isAuthenticated || userRole !== 'estadisticas') return; const now = new Date(); const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(); const patientsToday = attendedHistory.filter(p => p.horaLlegada >= todayStart); const stats = { totalAttendedToday: patientsToday.length, byTriage: patientsToday.reduce((acc, p) => { acc[p.nivelTriage] = (acc[p.nivelTriage] || 0) + 1; return acc; }, {}), avgWaitTime: patientsToday.length > 0 ? Math.round(patientsToday.reduce((sum, p) => sum + (p.attendedAt - p.horaLlegada), 0) / patientsToday.length / 60000) : 0 }; socket.emit('stats_update', stats); });
    socket.on('disconnect', () => console.log('Un cliente se ha desconectado.'));
});

// --- Inicio del Servidor ---
server.listen(PORT, () => { loadData(); const ip = getLocalIpAddress(); const url = `http://${ip}:${PORT}`; console.log('===================================================='); console.log('      Servidor de Triage INICIADO CORRECTAMENTE     '); console.log('===================================================='); console.log(`\nAccede al portal principal en tu navegador:`); console.log(`\x1b[32m%s\x1b[0m`, ` -> ${url}`); open(url); });
function getLocalIpAddress() { const interfaces = os.networkInterfaces(); for (const name of Object.keys(interfaces)) { for (const net of interfaces[name]) { if (net.family === 'IPv4' && !net.internal) { return net.address; } } } return 'localhost'; }
