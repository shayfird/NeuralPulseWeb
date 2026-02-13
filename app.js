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

                // NOTIFICATION STATE 2: AMBULANCE FOUND / EN ROUTE
                const notifTitle = document.getElementById('notif-title');
                const notifSubtitle = document.getElementById('notif-subtitle');
                const spinner = document.querySelector('.spinner-ring');

                if (spinner) {
                    // Replace Spinner with Success Icon
                    const icon = document.createElement('div');
                    icon.className = 'success-icon';
                    icon.innerHTML = '<i class="fas fa-check"></i>';
                    spinner.parentNode.replaceChild(icon, spinner);
                }

                notifTitle.innerText = "Ambulance En Route";
                notifSubtitle.innerText = `ETA: ${eta} mins`;

                // Show Map Sheet
                document.getElementById('patient-map-container').classList.remove('hidden-slide-up');
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
        // 1. Visual State Update (Immediate)
        const sosContainer = document.querySelector('.sos-center-container');
        sosContainer.classList.add('sos-active');

        // Disable button to prevent double-sends
        sosBtn.disabled = true;

        // Show Apple-style Notification
        const notification = document.getElementById('patient-notification-card');
        notification.classList.remove('hidden-slide-down');

        console.log("Patient GPS tracking started");
        // Start tracking first, then sos will be called when location is found
        startTracking();

        // 2. Real Logic: Wait for GPS Lock
        // Check for location
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
