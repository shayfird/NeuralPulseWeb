// FIREBASE CONFIGURATION
// ==========================================
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyACh3EtuKXyh68t7ZMIidHhxBk3DUnuKI0",
    authDomain: "neuralpulse-b9e9b.firebaseapp.com",
    databaseURL: "https://neuralpulse-b9e9b-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "neuralpulse-b9e9b",
    storageBucket: "neuralpulse-b9e9b.appspot.com",
    messagingSenderId: "763720075023",
    appId: "1:763720075023:web:f283b76129da3de341607a"
};

// Initialize Firebase
firebase.initializeApp(FIREBASE_CONFIG);
const db = firebase.database();
const storage = firebase.storage();

// GLOBAL STATE
// ==========================================
let currentState = {
    role: null,
    id: 'user_' + Math.floor(Math.random() * 1000), // Default random ID
    location: null,
    activeSOS: null
};

let map = null;
let markers = {};
let routeLayer = null;

// OPENROUTE SERVICE API
// ==========================================
const ORS_API_KEY = "5b3ce3597851110001cf6248b6f5d8e7c9a44b58b8f9e0f2d3c4e5f6";

// UTILITY FUNCTIONS
// ==========================================
function generateId() {
    return 'sos_' + Date.now();
}

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // metres
    const φ1 = lat1 * Math.PI / 180; // φ, λ in radians
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
        Math.cos(φ1) * Math.cos(φ2) *
        Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // in metres
}

function showView(viewId) {
    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
}

function initMap(containerId) {
    if (map) {
        map.remove();
        map = null;
    }
    // Default to SF
    map = L.map(containerId).setView([37.7749, -122.4194], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);
    markers = {};
}

// GEOLOCATION
// ==========================================
function startTracking() {
    if (!navigator.geolocation) {
        alert("Geolocation is not supported by your browser");
        return;
    }

    navigator.geolocation.watchPosition(
        (position) => {
            const { latitude, longitude } = position.coords;
            currentState.location = { lat: latitude, lng: longitude };

            console.log("📍 Location updated:", currentState.location);

            // Update Firebase based on role
            // Ambulance logic is handled in its own init function now for stricter intervals
            if (currentState.role === 'patient') {
                updatePatientMap(latitude, longitude);
                if (currentState.activeSOS) {
                    db.ref(`activeSOS/${currentState.activeSOS}`).update({
                        patientLat: latitude,
                        patientLng: longitude
                    });
                }
            }
        },
        (error) => {
            console.error("Error getting location:", error);
        },
        {
            enableHighAccuracy: true,
            maximumAge: 0,
            timeout: 5000
        }
    );
}

// ROUTING (OpenRouteService)
// ==========================================
async function getRoute(startLat, startLng, endLat, endLng) {
    const url = `https://api.openrouteservice.org/v2/directions/driving-car?api_key=${ORS_API_KEY}&start=${startLng},${startLat}&end=${endLng},${endLat}`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.features && data.features.length > 0) {
            const coordinates = data.features[0].geometry.coordinates.map(c => [c[1], c[0]]); // Flip for Leaflet

            if (routeLayer) map.removeLayer(routeLayer);

            routeLayer = L.polyline(coordinates, { color: '#007aff', weight: 6, opacity: 0.8 }).addTo(map);
            map.fitBounds(routeLayer.getBounds(), { padding: [50, 50] });

            const summary = data.features[0].properties.summary;
            return {
                distance: (summary.distance / 1000).toFixed(1) + ' km',
                duration: (summary.duration / 60).toFixed(0) + ' mins'
            };
        }
    } catch (e) {
        console.error("Routing Error:", e);
    }
    return null;
}




// ==========================================
// ROLE: PATIENT
// ==========================================
function initPatient() {
    initMap('patient-map');

    const sosBtn = document.getElementById('sos-btn');
    const statusBadge = document.getElementById('patient-status');
    const notificationCard = document.getElementById('notification-card');

    if (!sosBtn) return;

    sosBtn.addEventListener('click', async () => {

        if (!currentState.location) {
            alert("Waiting for GPS...");
            return;
        }

        sosBtn.classList.add('active');
        statusBadge.innerText = "SOS Sent";
        notificationCard.classList.remove('hidden');

        // 1. Read all ambulances
        const snapshot = await db.ref('ambulances').once('value');
        const ambulances = snapshot.val();

        if (!ambulances) return;

        let nearestId = null;
        let minDistance = Infinity;

        Object.keys(ambulances).forEach(id => {
            const amb = ambulances[id];
            // Only consider active ambulances
            if (amb.status === 'active') {
                const dist = getDistance(
                    currentState.location.lat,
                    currentState.location.lng,
                    amb.lat,
                    amb.lng
                );
                if (dist < minDistance) {
                    minDistance = dist;
                    nearestId = id;
                }
            }
        });

        // 2. Create SOS record
        const sosRef = db.ref('activeSOS').push();
        currentState.activeSOS = sosRef.key;

        await sosRef.set({
            patientId: currentState.id,
            patientLat: currentState.location.lat,
            patientLng: currentState.location.lng,
            assignedAmbulance: nearestId || "PENDING",
            status: "assigned",
            timestamp: Date.now()
        });

        document.getElementById('assigned-ambulance-id').innerText = nearestId || "Searching...";

        // 3. Listen to ambulance movement if assigned
        if (nearestId) {
            db.ref('ambulances/' + nearestId).on('value', async (snap) => {
                const amb = snap.val();
                if (!amb) return;

                updatePatientMapWithAmbulance(amb);

                if (currentState.location) {
                    const route = await getRoute(
                        currentState.location.lat,
                        currentState.location.lng,
                        amb.lat,
                        amb.lng
                    );

                    if (route) {
                        document.getElementById('patient-eta').innerText = route.duration;
                    }
                }
            });
        }
    });
}

function updatePatientMap(lat, lng) {
    if (!map) return;
    if (!markers['me']) {
        const icon = L.divIcon({
            className: 'custom-pin',
            html: `<div style="background-color: #007aff; width: 14px; height: 14px; border-radius: 50%; border: 2px solid white; box-shadow: 0 4px 6px rgba(0,0,0,0.3);"></div>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10]
        });
        markers['me'] = L.marker([lat, lng], { icon: icon }).addTo(map).bindPopup("You");
        map.setView([lat, lng], 15);
    } else {
        markers['me'].setLatLng([lat, lng]);
    }
}

function updatePatientMapWithAmbulance(ambLoc) {
    if (!map) return;

    if (!markers['assignedAmb']) {
        const icon = L.divIcon({
            className: 'custom-pin',
            html: `<div style="font-size: 24px;">🚑</div>`,
            iconSize: [30, 30],
            iconAnchor: [15, 15]
        });
        markers['assignedAmb'] = L.marker([ambLoc.lat, ambLoc.lng], { icon: icon }).addTo(map);
    } else {
        markers['assignedAmb'].setLatLng([ambLoc.lat, ambLoc.lng]);
    }
}

// ==========================================
// ROLE: AMBULANCE
// ==========================================
function initAmbulance() {
    initMap('ambulance-map');

    // 1. Setup ID and Continuous GPS Broadcast
    // Random ID for Hackathon Demo support (multiple phones)
    currentState.id = "AMB-" + Math.floor(Math.random() * 10000);
    document.getElementById('ambulance-unit-id').innerText = currentState.id;

    // Broadcast GPS every 2 seconds
    setInterval(() => {
        if (currentState.location && currentState.location.lat) {
            db.ref(`ambulances/${currentState.id}`).update({
                lat: currentState.location.lat,
                lng: currentState.location.lng,
                status: "active",
                timestamp: Date.now()
            });
            updateAmbulanceMap(currentState.location.lat, currentState.location.lng);
        }
    }, 2000);

    // Start getting location
    startTracking();

    // 2. Real-time Listener for Assignments
    // Logic: Only show ALERT if specific assignment comes in as NEW
    const startListenTime = Date.now();

    db.ref('activeSOS').on('child_added', (snapshot) => {
        const data = snapshot.val();

        // Strict check for assignment
        if (data.assignedAmbulance === currentState.id && data.status === 'assigned') {

            // Check if this is a NEW event or pre-existing
            const isNewEvent = data.timestamp > startListenTime;

            currentState.activeSOS = snapshot.key;
            console.log("Ambulance assignment received for SOS: " + snapshot.key);

            // Markers & Routing
            if (data.patientLat && data.patientLng) {
                // Patient Marker
                const icon = L.divIcon({
                    className: 'custom-pin',
                    html: `<div style="font-size: 24px;">🆘</div>`,
                    iconSize: [30, 30],
                    iconAnchor: [15, 15]
                });
                if (markers['patient']) map.removeLayer(markers['patient']);
                markers['patient'] = L.marker([data.patientLat, data.patientLng], { icon: icon }).addTo(map).bindPopup("Patient Location");

                // Route
                if (currentState.location) {
                    getRoute(currentState.location.lat, currentState.location.lng, data.patientLat, data.patientLng).then(r => {
                        // Update Alert UI if visible
                        if (r) {
                            document.getElementById('alert-distance').innerText = r.distance;
                            document.getElementById('alert-eta').innerText = r.duration;
                        }
                    });
                }
            }

            if (isNewEvent) {
                // Show Full Screen Alert
                showAmbulanceAlertUI(data);
                playEmergencySound();
            } else {
                // Silently activate Badge
                showCompactBadge();
            }
        }
    });

    // Accept Button Logic
    const acceptBtn = document.getElementById('btn-accept-emergency');
    if (acceptBtn) {
        acceptBtn.addEventListener('click', () => {
            // Hide Alert, Show Badge
            document.getElementById('emergency-overlay').classList.add('hidden');
            showCompactBadge();
        });
    }

    // Complete/Arrived Button Logic (in badge)
    const completeBtn = document.getElementById('btn-complete-job');
    if (completeBtn) {
        completeBtn.addEventListener('click', () => {
            if (!currentState.activeSOS) return;

            if (confirm("Mark Emergency as Completed?")) {
                db.ref(`activeSOS/${currentState.activeSOS}`).update({
                    status: 'picked_up'
                });

                // Reset UI
                document.getElementById('compact-status-badge').classList.add('hidden');
                if (markers['patient']) map.removeLayer(markers['patient']);
                if (routeLayer) map.removeLayer(routeLayer);
                currentState.activeSOS = null;
                alert("Status Updated: Patient Picked Up");
            }
        });
    }
}

function updateAmbulanceMap(lat, lng) {
    if (!map) return;
    if (!markers['me']) {
        const icon = L.divIcon({
            html: `<div style="font-size: 24px;">🚑</div>`,
            iconAnchor: [15, 15]
        });
        markers['me'] = L.marker([lat, lng], { icon: icon }).addTo(map);
        map.setView([lat, lng], 15);
    } else {
        markers['me'].setLatLng([lat, lng]);
    }
}

function showAmbulanceAlertUI(data) {
    // Populate Data
    document.getElementById('alert-coords').innerText = `${data.patientLat.toFixed(4)}, ${data.patientLng.toFixed(4)}`;
    document.getElementById('alert-distance').innerText = "Calculating...";
    document.getElementById('alert-eta').innerText = "Calculating...";

    // Show Overlay
    document.getElementById('emergency-overlay').classList.remove('hidden');
}

function showCompactBadge() {
    document.getElementById('compact-status-badge').classList.remove('hidden');
}

function playEmergencySound() {
    console.log("🔊 PLAYING EMERGENCY SOUND");
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.getType = 'square';
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(880, ctx.currentTime + 0.1);
        osc.frequency.linearRampToValueAtTime(440, ctx.currentTime + 0.2);
        osc.frequency.linearRampToValueAtTime(880, ctx.currentTime + 0.3);
        osc.frequency.linearRampToValueAtTime(440, ctx.currentTime + 0.4);

        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);

        osc.start();
        osc.stop(ctx.currentTime + 0.5);
    } catch (e) { console.warn("Audio play failed", e); }
}

// ==========================================
// ROLE: HOSPITAL
// ==========================================
function initHospital() {
    initMap('hospital-map');

    // Listen for all active SOS
    db.ref('activeSOS').on('value', (snapshot) => {
        const list = document.getElementById('hospital-alert-list');
        list.innerHTML = '';

        snapshot.forEach((child) => {
            const data = child.val();
            const id = child.key;

            // Only active cases
            if (data.status === 'assigned' || data.status === 'picked_up') {
                const li = document.createElement('li');
                li.className = 'alert-item glass-panel';
                li.innerHTML = `
                    <h4>🚨 Emergency #${id.substr(-4)}</h4>
                    <p>Status: <strong>${data.status.toUpperCase()}</strong></p>
                    <p>Ambulance: ${data.assignedAmbulance}</p>
                    ${data.hasMedicalFile ? `<p style="color:var(--accent-blue); margin-top:5px;">📋 Medical Record Available</p>` : ''}
                `;

                li.addEventListener('click', () => {
                    // Focus on map
                    if (data.patientLat && data.patientLng) {
                        map.setView([data.patientLat, data.patientLng], 16);

                        if (markers['selected']) map.removeLayer(markers['selected']);

                        markers['selected'] = L.marker([data.patientLat, data.patientLng])
                            .addTo(map)
                            .bindPopup(`Patient: ${data.patientId}<br>Ambulance: ${data.assignedAmbulance}`)
                            .openPopup();
                    }

                    // Check for file
                    db.ref(`hospitalAlerts/${id}`).once('value', (fileSnap) => {
                        const fileData = fileSnap.val();
                        if (fileData) {
                            if (confirm(`Open medical record: ${fileData.fileName}?`)) {
                                window.open(fileData.fileUrl, '_blank');
                            }
                        }
                    });
                });

                list.appendChild(li);

                // Add marker to map if not exists
                if (data.patientLat && data.patientLng && !markers[id]) {
                    markers[id] = L.marker([data.patientLat, data.patientLng]).addTo(map);
                }
            }
        });
    });
}

// ==========================================
// ROLE: TRAFFIC CONTROLLER
// ==========================================
function initTraffic() {
    const logList = document.getElementById('traffic-log');

    function addLog(msg) {
        const li = document.createElement('li');
        li.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
        li.style.color = '#ccc';
        li.style.marginBottom = '5px';
        logList.prepend(li);
    }

    // Listen to traffic signals
    db.ref('trafficSignals/signal1').on('value', (snap) => {
        const status = snap.val();
        document.querySelectorAll('.light').forEach(el => el.classList.remove('active'));

        if (status === 'GREEN') {
            document.querySelector('.light.green').classList.add('active');
        } else if (status === 'RED') {
            document.querySelector('.light.red').classList.add('active');
        } else {
            document.querySelector('.light.yellow').classList.add('active');
        }
    });

    // Button Logic
    const verifyBtn = document.getElementById('btn-verify-ambulance');
    verifyBtn.addEventListener('click', () => {
        addLog("Verifying Ambulance via Camera Feed...");

        // Simulate "Verification" delay
        verifyBtn.innerText = "Verifying...";
        verifyBtn.disabled = true;

        setTimeout(() => {
            verifyBtn.innerText = "Ambulance Verified. Override Active.";
            verifyBtn.style.background = "#30d158"; // Green

            // Update Firebase
            db.ref('trafficSignals/signal1').set("GREEN");
            addLog("Signal 1 set to GREEN (Priority Override)");

            // Reset after 10 seconds
            setTimeout(() => {
                db.ref('trafficSignals/signal1').set("RED");
                addLog("Signal 1 reset to normal cycle");
                verifyBtn.innerText = "Verify Ambulance & Green Light";
                verifyBtn.disabled = false;
                verifyBtn.style.background = "";
            }, 10000);

        }, 1500);
    });

    // Initial state
    db.ref('trafficSignals/signal1').set("RED");
}

// ==========================================
// MAIN INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', () => {

    // Role Selection
    document.querySelectorAll('.role-card').forEach(card => {
        card.addEventListener('click', () => {
            const role = card.dataset.role;
            currentState.role = role;

            if (role === 'ambulance') {
                // Fixed ID for pilot testing
                // currentState.id = prompt("Enter ambulance ID (example: ambulance1)");
                currentState.id = "AMB001";
                alert("Ambulance ID set to AMB001 for testing");
            }

            // Hide selector, show specific view
            document.getElementById('view-role-selector').classList.remove('active');
            showView(`view-${role}`);

            // if (role !== 'patient') startTracking(); // Handled inside inits now

            if (role === 'patient') initPatient();
            if (role === 'ambulance') initAmbulance();
            if (role === 'hospital') initHospital();
            if (role === 'traffic') initTraffic();
        });
    });

});
