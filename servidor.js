// 1. Configuración del servidor
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const os = require('os');

// --- CONFIGURACIÓN DE SEGURIDAD ---
const PASSWORD = "RAC2025%";
const SESSION_TOKEN = "secret-triage-token-a1b2c3d4e5"; // Token para recordar la sesión

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = 3000;

app.use(express.static(__dirname));

// **NUEVO: Redirección de la ruta principal**
// Esto soluciona el error "CANNOT GET /"
app.get('/', (req, res) => {
    res.redirect('/registro.html');
});


// 2. Lógica de la aplicación
let patients = [];
let isEmergency = false;
let currentlyCalled = null;
const triageOrder = { 'rojo': 1, 'amarillo': 2, 'verde': 3, 'azul': 4 };

const sortPatients = () => {
    patients.sort((a, b) => {
        if (a.ordenTriage !== b.ordenTriage) return a.ordenTriage - b.ordenTriage;
        return a.horaLlegada - b.horaLlegada;
    });
};

io.on('connection', (socket) => {
    console.log('Un cliente se ha conectado.');
    let isAuthenticated = false;

    // --- Lógica de Autenticación ---
    const authenticateSocket = () => {
        isAuthenticated = true;
        socket.emit('auth_success', { token: SESSION_TOKEN });
        socket.emit('update_patient_list', patients);
        socket.emit('emergency_status_update', isEmergency);
    };

    socket.on('authenticate_password', (password) => {
        if (password === PASSWORD) {
            authenticateSocket();
        } else {
            socket.emit('auth_fail');
        }
    });

    socket.on('authenticate_token', (token) => {
        if (token === SESSION_TOKEN) {
            authenticateSocket();
        } else {
            socket.emit('auth_fail');
        }
    });
    
    // Enviar datos públicos a todos los clientes (para la TV)
    socket.emit('update_patient_list', patients);
    socket.emit('emergency_status_update', isEmergency);
    socket.emit('update_call', currentlyCalled);

    // --- Eventos Protegidos ---
    const setupProtectedEvents = () => {
        const protectedEvents = {
            'register_patient': (newPatient) => {
                patients.push(newPatient);
                sortPatients();
                io.emit('update_patient_list', patients);
                io.emit('new_patient_notification', { patient: newPatient, patientCount: patients.length });
            },
            'delete_patient': (patientId) => {
                patients = patients.filter(p => p.id !== patientId);
                io.emit('update_patient_list', patients);
            },
            'update_patient_level': ({ id, newLevel }) => {
                const p = patients.find(p => p.id === id);
                if (p) { p.nivelTriage = newLevel; p.ordenTriage = triageOrder[newLevel]; sortPatients(); io.emit('update_patient_list', patients); }
            },
            'call_patient': ({ id, consultorio }) => {
                const p = patients.find(p => p.id === id);
                if (p) { currentlyCalled = { nombre: p.nombre, consultorio }; p.status = 'atendiendo'; p.consultorio = consultorio; io.emit('update_call', currentlyCalled); io.emit('update_patient_list', patients); setTimeout(() => { currentlyCalled = null; io.emit('update_call', null); }, 20000); }
            },
            'update_patient_status': ({ id, status }) => {
                const p = patients.find(p => p.id === id);
                if (p) { p.status = status; if (status === 'ausente') { delete p.consultorio; } io.emit('update_patient_list', patients); }
            },
            'start_emergency': () => { isEmergency = true; io.emit('emergency_status_update', isEmergency); },
            'end_emergency': () => { isEmergency = false; io.emit('emergency_status_update', isEmergency); }
        };

        for (const eventName in protectedEvents) {
            socket.on(eventName, (data) => {
                if (!isAuthenticated) return;
                protectedEvents[eventName](data);
            });
        }
    };
    
    setupProtectedEvents();
    socket.on('disconnect', () => console.log('Un cliente se ha desconectado.'));
});

// 3. Iniciar el servidor
function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) return net.address;
        }
    }
    return 'localhost';
}

server.listen(PORT, () => {
    const ip = getLocalIpAddress();
    console.log('----------------------------------------------------');
    console.log('      Servidor de Triage INICIADO CORRECTAMENTE     ');
    console.log('----------------------------------------------------');
    console.log(`\n -> App de Registro: http://${ip}:${PORT}/registro.html`);
    console.log(` -> App del Médico:   http://${ip}:${PORT}/medico.html`);
    console.log(` -> Pantalla de TV:   http://${ip}:${PORT}/tv.html`);
});

