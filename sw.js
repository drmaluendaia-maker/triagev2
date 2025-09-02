// =================================================================================
// SERVICE WORKER PARA NOTIFICACIONES PUSH
// Autor: Dr. Maluenda IA & Gemini
// Descripción: Se ejecuta en segundo plano para recibir eventos del servidor
// y mostrar notificaciones nativas en el dispositivo.
// =================================================================================

// 1. Importar la librería de Socket.IO
self.importScripts('/socket.io/socket.io.js');

// 2. Conectarse al servidor
const socket = io();

console.log('Service Worker iniciado y conectado.');

// --- Lógica de Notificaciones ---

// Función para hacer vibrar el dispositivo (si es soportado)
const playSound = () => {
    if ('vibrate' in self.navigator) {
        self.navigator.vibrate([200, 100, 200]); // Vibra, pausa, vibra
    }
};

// Función para mostrar la notificación
const showNotification = (title, options) => {
    self.registration.showNotification(title, options);
};

// 3. Escuchar los eventos del servidor

// Escuchar la llegada de nuevos pacientes
socket.on('new_patient_notification', ({ patient, patientCount }) => {
    console.log('Service Worker recibió notificación de nuevo paciente:', patient.nombre);
    
    const arrivalTime = new Date(patient.horaLlegada).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const options = {
        body: `Nivel: ${patient.nivelTriage.toUpperCase()}\nLlegada: ${arrivalTime}\n${patient.notas ? 'Notas: ' + patient.notas : ''}`,
        icon: '/logo.png',
        tag: `patient-${patient.id}` // Agrupa notificaciones
    };

    if (patient.nivelTriage === 'rojo') {
        playSound();
        showNotification(`¡NIVEL 1! - ${patient.nombre}`, options);
    } else if (patient.nivelTriage === 'naranja') {
        playSound();
        showNotification(`¡NIVEL 2 - ALTA URGENCIA! - ${patient.nombre}`, options);
    } else if (patient.nivelTriage === 'amarillo' && patientCount === 1) {
        playSound();
        showNotification(`Paciente Nivel 3 (Sin espera) - ${patient.nombre}`, options);
    }
});

// Escuchar el inicio de una emergencia
socket.on('emergency_status_update', (isEmergency) => {
    if (isEmergency) {
        console.log('Service Worker recibió notificación de EMERGENCIA.');
        playSound();
        showNotification("¡EMERGENCIA ACTIVADA!", {
            body: "Se ha activado el protocolo de emergencia. Todos los médicos al shock room.",
            icon: '/logo.png',
            tag: 'emergency-alert'
        });
    }
});
