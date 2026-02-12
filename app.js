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
async function createSOS(lat, lng) {
    const sosBtn = document.getElementById('sos-btn');

    sosBtn.classList.add('active');
    sosBtn.innerHTML = "<span>SOS SENT</span>";
    document.getElementById('patient-status').textContent = "Searching for Ambulance...";
    document.getElementById('patient-status').classList.add('warning');

    // 1. Find nearest ambulance
    const snapshot = await db.ref('ambulances').once('value');
    const ambulances = snapshot.val() || {};

    let nearestId = null;
    let minDist = Infinity;

    Object.keys(ambulances).forEach(key => {
        const amb = ambulances[key];
        if (amb.status === 'active') { // Only active
            // Calculate distance to find nearest
            const dist = getDistance(lat, lng, amb.lat, amb.lng);
            if (dist < minDist) {
                minDist = dist;
                nearestId = key;
            }
        }
    });

    // 2. Create SOS Record using push()
    const sosRef = db.ref("activeSOS").push();
    const sosId = sosRef.key;
    currentState.activeSOS = sosId;

    const sosData = {
        patientId: currentState.id,
        patientLat: lat,
        patientLng: lng,
        assignedAmbulance: nearestId || "PENDING",
        status: "assigned",
        timestamp: Date.now()
    };

    sosRef.set(sosData);

    if (nearestId) {
        document.getElementById('patient-status').textContent = "Ambulance INBOUND";
        document.getElementById('patient-status').classList.remove('warning');
        document.getElementById('patient-status').classList.add('success');

        document.getElementById('assigned-ambulance-id').textContent = nearestId;
        document.getElementById('patient-info-panel').classList.remove('hidden');

        // 3. Listener for Ambulance Live Location
        db.ref(`ambulances/${nearestId}`).on('value', (snap) => {
            const ambLoc = snap.val();
            if (ambLoc) {
                updatePatientMapWithAmbulance(ambLoc);

                // Update ETA & Distance
                const dist = getDistance(currentState.location.lat, currentState.location.lng, ambLoc.lat, ambLoc.lng);
                const eta = Math.ceil(dist * 1.5); // 1.5 mins per km
                document.getElementById('patient-eta').textContent = `${eta} mins`;
            }
        });

        // 4. Recalculate Route Loop (Every 5 seconds)
        if (window.patientRouteInterval) clearInterval(window.patientRouteInterval);

        window.patientRouteInterval = setInterval(() => {
            db.ref(`ambulances/${nearestId}`).once('value', (snap) => {
                const ambLoc = snap.val();
                if (ambLoc && currentState.location) {
                    getRoute(currentState.location.lat, currentState.location.lng, ambLoc.lat, ambLoc.lng);
                }
            });
        }, 5000);

        // Initial Route
        db.ref(`ambulances/${nearestId}`).once('value', (snap) => {
            const ambLoc = snap.val();
            if (ambLoc) getRoute(currentState.location.lat, currentState.location.lng, ambLoc.lat, ambLoc.lng);
        });

    } else {
        document.getElementById('patient-status').textContent = "No Ambulances Available. Alerting Hospital...";
    }
}

function initPatient() {
    initMap('patient-map');
    const sosBtn = document.getElementById('sos-btn');
    const fileInput = document.getElementById('medical-file');

    sosBtn.addEventListener('click', async () => {
        console.log("Patient GPS tracking started");
        // Start tracking first, then sos will be called when location is found
        startTracking();

        // Force immediate SOS if location already exists
        if (currentState.location && currentState.location.lat) {
            createSOS(currentState.location.lat, currentState.location.lng);
        } else {
            // Wait for first location update then trigger SOS
            const checkLoc = setInterval(() => {
                if (currentState.location && currentState.location.lat) {
                    clearInterval(checkLoc);
                    createSOS(currentState.location.lat, currentState.location.lng);
                }
            }, 1000);
        }
    });

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file || !currentState.activeSOS) return;

        // Using a timestamp to ensure uniqueness
        const storageRef = storage.ref(`medical_records/${currentState.activeSOS}/${Date.now()}_${file.name}`);
        storageRef.put(file).then((snapshot) => {
            snapshot.ref.getDownloadURL().then((url) => {
                db.ref(`hospitalAlerts/${currentState.activeSOS}`).update({
                    fileUrl: url,
                    fileName: file.name
                });
                document.getElementById('file-name').textContent = "Uploaded: " + file.name;
                db.ref(`activeSOS/${currentState.activeSOS}`).update({ hasMedicalFile: true });
            });
        });
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
    currentState.id = "AMB001";
    document.getElementById('ambulance-unit-id').innerText = currentState.id;

    // Broadcast GPS every 2 seconds
    setInterval(() => {
        // We use navigator.geolocation directly or rely on startTracking.
        // Let's use startTracking for the updates but here we force the DB update
        // actually startTracking updates DB for patient, let's call startTracking for ambulance too
        // but adding the periodic forced update is good for aliveness.

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
    db.ref('activeSOS').on('child_added', (snapshot) => {
        const data = snapshot.val();

        // Strict check for assignment
        if (data.assignedAmbulance === currentState.id && data.status === 'assigned') {
            currentState.activeSOS = snapshot.key;
            console.log("Ambulance assignment received for SOS: " + snapshot.key);

            // UI & Sound
            showAmbulanceAlertUI(data);
            playEmergencySound();

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
                    getRoute(currentState.location.lat, currentState.location.lng, data.patientLat, data.patientLng);
                }
            }
        }
    });

    document.getElementById('btn-picked-up').addEventListener('click', () => {
        // Logic for picking up and routing to hospital
        if (!currentState.activeSOS) return;

        const btn = document.getElementById('btn-picked-up');
        btn.innerText = "Rerouting to Hospital...";
        btn.disabled = true;

        db.ref(`activeSOS/${currentState.activeSOS}`).update({
            status: 'picked_up'
        });

        // Find nearest Hospital (Hardcoded for demo, normally would search DB)
        const hospitalLoc = { lat: 37.7749, lng: -122.4194 }; // Example: SF
        // Ideally use current location to find real nearest hospital using logic similar to ambulance search

        // Mock Hospital Location relative to current location for demo purposes so it's visible on map
        if (currentState.location) {
            const mockHospital = {
                lat: currentState.location.lat + 0.02,
                lng: currentState.location.lng + 0.02
            };

            drawRoute(currentState.location, mockHospital).then(info => {
                if (info) {
                    document.getElementById('amb-distance').innerText = info.distance + " (to Hospital)";
                    document.getElementById('amb-eta').innerText = info.duration;
                }
            });

            if (!markers['hospital']) {
                const icon = L.divIcon({
                    html: `<div style="font-size: 24px;">🏥</div>`,
                    iconAnchor: [15, 15]
                });
                markers['hospital'] = L.marker([mockHospital.lat, mockHospital.lng], { icon: icon }).addTo(map).bindPopup("Destination Hospital").openPopup();
            }
        }
    });
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
    document.getElementById('no-assignment').classList.add('hidden');
    document.getElementById('active-assignment').classList.remove('hidden');
    document.getElementById('amb-distance').innerText = "Calculating...";
    document.getElementById('amb-eta').innerText = "Calculating...";
    alert("🚨 New Emergency Assigned");
}

function playEmergencySound() {
    // Simple beep/alert logic (Browsers might block auto-play without interaction)
    // Using a simple oscillator if possible, or just a console log for now as no asset provided
    console.log("🔊 PLAYING EMERGENCY SOUND");
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        osc.getType = 'sawtooth';
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.5);
        osc.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 1);
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
