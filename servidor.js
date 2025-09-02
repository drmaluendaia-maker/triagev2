// =================================================================================
// SERVIDOR DE LA APLICACIÓN DE TRIAGE V2
// Autor: Dr. Maluenda IA & Gemini
// Descripción: Gestiona la lógica de negocio, la comunicación en tiempo real
// y la persistencia de datos para el sistema de triage.
// =================================================================================

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

// Archivos de base de datos
const DB_FILE = 'pacientes.json';
const USERS_FILE = 'usuarios.json';
const PRESETS_FILE = 'presets.json';

const ADMIN_MASTER_PASS = "superadmin";
let users = [];

// Servir archivos estáticos y redirigir la raíz al portal
app.use(express.static(__dirname));
app.get('/', (req, res) => res.redirect('/index.html'));

// 2. Estado de la aplicación en memoria
let patients = [];
let attendedHistory = [];
let observationPresets = [];
let isEmergency = false;
let currentlyCalled = null;
const triageOrder = { 'rojo': 1, 'naranja': 2, 'amarillo': 3, 'verde': 4, 'azul': 5 };

// --- Funciones de persistencia de datos ---
const saveData = () => { fs.writeFile(DB_FILE, JSON.stringify({ patients, attendedHistory }, null, 2), err => { if (err) console.error("Error guardando datos de pacientes:", err); }); };
const saveUsers = () => { fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), err => { if (err) console.error("Error guardando usuarios:", err); }); };
const savePresets = () => { fs.writeFile(PRESETS_FILE, JSON.stringify(observationPresets, null, 2), err => { if (err) console.error("Error guardando presets:", err); }); };

const loadData = () => {
    try {
        if (fs.existsSync(DB_FILE)) { const data = JSON.parse(fs.readFileSync(DB_FILE)); patients = data.patients || []; attendedHistory = data.attendedHistory || []; }
        if (fs.existsSync(USERS_FILE)) { users = JSON.parse(fs.readFileSync(USERS_FILE)); } else { users = [{ user: "admin", pass: "admin2025", role: "registro", fullName: "Admin Enfermería" }, { user: "medico1", pass: "med1", role: "medico", fullName: "Dr. House" }, { user: "stats", pass: "stats123", role: "estadisticas", fullName: "Jefe de Guardia" }]; }
        users.forEach(u => { if (!u.token) u.token = crypto.randomBytes(16).toString('hex'); });
        saveUsers();
        if (fs.existsSync(PRESETS_FILE)) { observationPresets = JSON.parse(fs.readFileSync(PRESETS_FILE)); } else { observationPresets = [ { text: "Parada cardiorrespiratoria", level: "rojo" }, { text: "Dolor torácico", level: "naranja" }, { text: "Tos con mocos", level: "verde" }]; savePresets(); }
        console.log("Datos cargados correctamente desde los archivos .json.");
    } catch (err) { console.error("Error al cargar datos:", err); }
};

// --- Funciones de utilidad ---
const sortPatients = () => { patients.sort((a, b) => { if (a.ordenTriage !== b.ordenTriage) return a.ordenTriage - b.ordenTriage; return a.horaLlegada - b.horaLlegada; }); };
const getNurseShift = (date) => { const hour = date.getHours(); const minutes = date.getMinutes(); const time = hour + minutes / 60; if (time >= 6.5 && time < 14.5) return "Mañana"; if (time >= 14.5 && time < 22.5) return "Tarde"; return "Noche"; };
const getDoctorGuard = (date) => { let guardDate = new Date(date); if (date.getHours() < 8) { guardDate.setDate(guardDate.getDate() - 1); } const dayName = guardDate.toLocaleDateString('es-ES', { weekday: 'long' }); const dayMonth = guardDate.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' }); return `Guardia del ${dayName.charAt(0).toUpperCase() + dayName.slice(1)} ${dayMonth}`; };

// 3. Lógica de Sockets (Comunicación en tiempo real)
io.on('connection', (socket) => {
    let isAuthenticated = false; let userRole = null; let currentUser = null;
    
    // --- Autenticación ---
    const authenticateSocket = (user) => {
        isAuthenticated = true;
        userRole = user.role;
        currentUser = user;
        socket.emit('auth_success', user);
        if (user.role === 'registro' || user.role === 'admin') {
            socket.emit('presets_update', observationPresets);
        }
    };
    socket.on('authenticate_user', ({ user, pass }) => { const foundUser = users.find(u => u.user === user && u.pass === pass); if (foundUser) authenticateSocket(foundUser); else socket.emit('auth_fail'); });
    socket.on('authenticate_token', (token) => { const foundUser = users.find(u => u.token === token); if (foundUser) authenticateSocket(foundUser); else { socket.emit('auth_fail'); } });
    
    // --- Emisiones iniciales al conectar ---
    socket.emit('update_patient_list', patients); 
    socket.emit('emergency_status_update', isEmergency); 
    socket.emit('update_call', currentlyCalled);
    
    // --- Lógica de Administración (futura) ---
    // ... aquí irían las funciones de gestión de usuarios, etc.

    // --- Lógica de Historial de Pacientes ---
    socket.on('search_patient_history', ({ query, role }) => {
        if (!isAuthenticated) return;
        const normalizedQuery = query.toUpperCase().trim();
        let results = attendedHistory
            .filter(p => (p.dni && p.dni.includes(normalizedQuery)) || p.nombre.toUpperCase().includes(normalizedQuery))
            .sort((a, b) => b.attendedAt - a.attendedAt);
        // El rol 'registro' no debería ver las notas médicas en la búsqueda inicial
        if (role === 'registro') {
            results = results.map(p => { const { doctorNotes, ...patientData } = p; return patientData; });
        }
        socket.emit('patient_history_result', results);
    });

    // --- Lógica principal de gestión de pacientes ---
    const setupProtectedEvents = () => {
        const events = {
            'register_patient': (newPatient) => {
                if (userRole !== 'registro') return;
                newPatient.registeredBy = currentUser.user;
                newPatient.shift = getNurseShift(new Date(newPatient.horaLlegada));
                patients.push(newPatient);
                sortPatients();
                io.emit('new_patient_notification', { patient: newPatient, patientCount: patients.length });
            },
            'mark_as_attended': ({ patientId, attendedByUsername }) => {
                const patientIndex = patients.findIndex(p => p.id === patientId);
                if (patientIndex > -1) {
                    const [attendedPatient] = patients.splice(patientIndex, 1);
                    attendedPatient.attendedAt = Date.now();
                    const attendingUser = users.find(u => u.user === attendedByUsername);
                    attendedPatient.attendedBy = attendingUser ? attendingUser.fullName : attendedByUsername;
                    attendedPatient.guardDay = getDoctorGuard(new Date(attendedPatient.attendedAt));
                    attendedHistory.push(attendedPatient);
                }
            },
            'update_patient_level': ({ id, newLevel }) => {
                if (userRole !== 'registro') return;
                const p = patients.find(p => p.id === id);
                if (p) {
                    p.nivelTriage = newLevel;
                    p.ordenTriage = triageOrder[newLevel];
                    sortPatients();
                }
            },
            'add_nurse_evolution': ({ id, note }) => {
                if (userRole !== 'registro') return;
                const patient = patients.find(p => p.id === id);
                if (patient) {
                    if (!patient.nurseEvolutions) patient.nurseEvolutions = [];
                    patient.nurseEvolutions.push({ text: note, user: currentUser.fullName, timestamp: Date.now() });
                }
            },
            'add_observation_to_attended': ({ id, note }) => {
                if (!isAuthenticated) return;
                const patient = attendedHistory.find(p => p.id === id);
                if (patient) {
                    if (userRole === 'registro') {
                        if (!patient.nurseEvolutions) patient.nurseEvolutions = [];
                        patient.nurseEvolutions.push({ text: note, user: currentUser.fullName, timestamp: Date.now() });
                    } else if (userRole === 'medico') {
                        if (!patient.doctorNotes) patient.doctorNotes = [];
                        patient.doctorNotes.push({ text: note, doctor: currentUser.fullName, timestamp: Date.now() });
                    }
                }
            },
            'call_patient': ({ id, consultorio }) => {
                if (userRole !== 'medico') return;
                // Liberar paciente anterior del mismo médico, si lo hay
                const currentlyAttending = patients.find(pt => pt.doctor_user === currentUser.user && pt.status === 'atendiendo');
                if (currentlyAttending) {
                    currentlyAttending.status = currentlyAttending.previousStatus || 'en_espera';
                    delete currentlyAttending.consultorio;
                    delete currentlyAttending.doctor_user;
                    delete currentlyAttending.doctor_name;
                }
                const p = patients.find(p => p.id === id);
                if (p) {
                    p.previousStatus = p.status;
                    p.status = 'atendiendo';
                    p.consultorio = consultorio;
                    p.doctor_user = currentUser.user;
                    p.doctor_name = currentUser.fullName;
                    currentlyCalled = { nombre: p.nombre, consultorio };
                    io.emit('update_call', currentlyCalled);
                    setTimeout(() => { currentlyCalled = null; io.emit('update_call', null); }, 20000); // El llamado dura 20s
                }
            },
            'update_patient_status': ({ id, status }) => {
                if (userRole !== 'medico') return;
                const p = patients.find(p => p.id === id);
                if (p) {
                    p.status = status;
                    if (status === 'ausente' || status === 'pre_internacion') {
                        delete p.consultorio;
                    }
                    sortPatients();
                }
            },
            'start_emergency': () => {
                isEmergency = true;
                io.emit('emergency_status_update', isEmergency);
            },
            'end_emergency': () => {
                isEmergency = false;
                io.emit('emergency_status_update', isEmergency);
            },
            'add_doctor_note': ({ id, note }) => {
                if (userRole !== 'medico') return;
                const patient = patients.find(p => p.id === id);
                if (patient) {
                    if (!patient.doctorNotes) patient.doctorNotes = [];
                    patient.doctorNotes.push({ text: note, doctor: currentUser.fullName, timestamp: Date.now() });
                }
            },
            'continue_care': (patientId) => {
                if (userRole !== 'medico') return;
                const historyIndex = attendedHistory.findIndex(p => p.id === patientId);
                if (historyIndex > -1) {
                    const [patientToReactivate] = attendedHistory.splice(historyIndex, 1);
                    patientToReactivate.status = 'pre_internacion'; // Pasa a pre-internación
                    delete patientToReactivate.consultorio;
                    delete patientToReactivate.doctor_user;
                    delete patientToReactivate.doctor_name;
                    patients.push(patientToReactivate);
                    sortPatients();
                }
            }
        };

        // Registrar todos los eventos protegidos
        for (const eventName in events) {
            socket.on(eventName, (data) => {
                if (!isAuthenticated) return; // Guard clause
                events[eventName](data);
                saveData(); // Guardar estado después de cada acción
                io.emit('update_patient_list', patients);
            });
        }
    };
    setupProtectedEvents();

    // --- Lógica de Reportes y Estadísticas (futura) ---
    // ... aquí irían las funciones para generar reportes

    socket.on('disconnect', () => console.log('Un cliente se ha desconectado.'));
});

// 4. Inicio del Servidor
server.listen(PORT, () => {
    loadData();
    const ip = getLocalIpAddress();
    const url = `http://${ip}:${PORT}`;
    console.log('====================================================');
    console.log('      Servidor de Triage INICIADO CORRECTAMENTE     ');
    console.log('====================================================');
    console.log(`\nAccede al portal principal en tu navegador:`);
    console.log(`\x1b[32m%s\x1b[0m`, ` -> ${url}`);
    open(url);
});

function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return 'localhost';
}
