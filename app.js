// NeuralPulse Web App Logic

// ==========================================
// CONFIGURATION
// ==========================================
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyACh3EtuKXyh68t7ZMIidHhxBk3DUnuKI0",
    authDomain: "neuralpulse-b9e9b.firebaseapp.com",
    databaseURL: "https://neuralpulse-b9e9b-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "neuralpulse-b9e9b",
    storageBucket: "neuralpulse-b9e9b.firebasestorage.app",
    messagingSenderId: "763720075023",
    appId: "1:763720075023:web:f283b76129da3de341607a",
    measurementId: "G-FRD7LHZYR6"
};

const ORS_API_KEY = "ORS_API_KEY";

// Initialize Firebase
const app = firebase.initializeApp(FIREBASE_CONFIG);
const db = firebase.database();
const storage = firebase.storage();

// State
let currentState = {
    role: null,
    location: null, // { lat, lng }
    id: generateId(),
    activeSOS: null,
    assignedAmbulance: null
};

// ==========================================
// UTILITIES
// ==========================================
function generateId() {
    return 'user_' + Math.random().toString(36).substr(2, 9);
}

function showView(viewId) {
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
}

// Haversine Formula for distance (km)
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of the earth in km
    const dLat = deg2rad(lat2 - lat1);
    const dLon = deg2rad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function deg2rad(deg) {
    return deg * (Math.PI / 180);
}

// ==========================================
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
            if (currentState.role === 'ambulance') {
                db.ref(`ambulances/${currentState.id}`).update({
                    lat: latitude,
                    lng: longitude,
                    timestamp: Date.now(),
                    status: 'active'
                });
                console.log("Ambulance location updated successfully");
                updateAmbulanceMap(latitude, longitude);
            } else if (currentState.role === 'patient') {
                if (!currentState.activeSOS) {
                    createSOS(latitude, longitude);
                } else {
                    db.ref(`activeSOS/${currentState.activeSOS}`).update({
                        lat: latitude,
                        lng: longitude
                    });
                    db.ref(`patients/${currentState.id}`).update({
                        lat: latitude,
                        lng: longitude,
                        timestamp: Date.now()
                    });
                    console.log("Patient location updated in Firebase");
                }
                updatePatientMap(latitude, longitude);
            }
        },
        (error) => {
            console.error("Geolocation error:", error);
            if (error.code === error.PERMISSION_DENIED) {
                alert("Location permission required for emergency services");
            }
        },
        {
            enableHighAccuracy: true,
            maximumAge: 0,
            timeout: 5000
        }
    );
}

// ==========================================
// MAP & ROUTING (Leaflet + ORS)
// ==========================================
let map = null;
let markers = {};
let routeLayer = null;

function initMap(elementId) {
    if (map) {
        map.remove();
        map = null;
    }

    // Default to a central location until GPS kicks in
    map = L.map(elementId).setView([0, 0], 13);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
}

async function drawRoute(start, end) {
    if (!start || !end) return;

    // OpenRouteService API
    const url = `https://api.openrouteservice.org/v2/directions/driving-car?api_key=${ORS_API_KEY}&start=${start.lng},${start.lat}&end=${end.lng},${end.lat}`;

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
            const dist = getDistance(lat, lng, amb.lat, amb.lng);
            if (dist < minDist) {
                minDist = dist;
                nearestId = key;
            }
        }
    });

    if (nearestId) {
        console.log("Nearest ambulance selected: " + nearestId);
    } else {
        console.log("No active ambulance found");
    }

    const sosId = generateId();
    currentState.activeSOS = sosId;

    // 2. Create SOS Record with EXACT GPS
    const sosData = {
        patientId: currentState.id,
        patientLat: currentState.location.lat, // Use Exact State
        patientLng: currentState.location.lng, // Use Exact State
        assignedAmbulance: nearestId || "PENDING",
        timestamp: Date.now(),
        status: 'assigned'
    };

    db.ref(`activeSOS/${sosId}`).set(sosData);

    if (nearestId) {
        document.getElementById('patient-status').textContent = "Ambulance INBOUND";
        document.getElementById('patient-status').classList.remove('warning');
        document.getElementById('patient-status').classList.add('success');

        document.getElementById('assigned-ambulance-id').textContent = nearestId;
        document.getElementById('patient-info-panel').classList.remove('hidden');

        // Initiate listener for ambulance LIVE location
        db.ref(`ambulances/${nearestId}`).on('value', (snap) => {
            const ambLoc = snap.val();
            if (ambLoc) {
                updatePatientMapWithAmbulance(ambLoc);

                // Update Patient ETA using real-time calculation
                const dist = getDistance(currentState.location.lat, currentState.location.lng, ambLoc.lat, ambLoc.lng);
                // Rough estimate: 60km/h = 1km/min
                const eta = Math.ceil(dist * 1.5); // 1.5 mins per km traffic
                document.getElementById('patient-eta').textContent = `${eta} mins`;
            }
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

    // FORCE FIXED ID FOR TESTING
    currentState.id = "AMB001";
    document.getElementById('ambulance-unit-id').innerText = currentState.id;

    // Listen for assignments
    db.ref('activeSOS').on('child_added', (snapshot) => {
        const data = snapshot.val();

        // Strict check for assignment
        if (data.assignedAmbulance === currentState.id && data.status === 'assigned') {
            currentState.activeSOS = snapshot.key;
            console.log("Ambulance assignment received for SOS: " + snapshot.key);
            alert("🚨 New Emergency Assigned");

            // Show alert box
            document.getElementById('no-assignment').classList.add('hidden');
            document.getElementById('active-assignment').classList.remove('hidden');

            // Draw Route to Patient
            if (data.patientLat && data.patientLng) {
                // Add Patient Marker
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

    // Also check existing SOS (in case of reload)
    db.ref('activeSOS').once('value', (snapshot) => {
        snapshot.forEach((child) => {
            const data = child.val();
            if (data.assignedAmbulance === currentState.id && data.status === 'assigned') {
                // Trigger same logic
                currentState.activeSOS = child.key;
                document.getElementById('no-assignment').classList.add('hidden');
                document.getElementById('active-assignment').classList.remove('hidden');

                if (data.patientLat && data.patientLng) {
                    const icon = L.divIcon({
                        className: 'custom-pin',
                        html: `<div style="font-size: 24px;">🆘</div>`,
                        iconSize: [30, 30],
                        iconAnchor: [15, 15]
                    });
                    if (markers['patient']) map.removeLayer(markers['patient']);
                    markers['patient'] = L.marker([data.patientLat, data.patientLng], { icon: icon }).addTo(map).bindPopup("Patient Location");

                    if (currentState.location) {
                        getRoute(currentState.location.lat, currentState.location.lng, data.patientLat, data.patientLng);
                    }
                }
            }
        });
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

async function handleNewAssignment(sosId, data) {
    currentState.activeSOS = sosId;
    document.getElementById('no-assignment').classList.add('hidden');
    document.getElementById('active-assignment').classList.remove('hidden');

    // Add Patient Marker
    const icon = L.divIcon({
        html: `<div style="font-size: 24px;">🆘</div>`,
        iconAnchor: [15, 15]
    });
    markers['patient'] = L.marker([data.lat, data.lng], { icon: icon }).addTo(map).bindPopup("Patient Location").openPopup();

    // Draw route
    if (currentState.location) {
        const routeInfo = await drawRoute(currentState.location, { lat: data.lat, lng: data.lng });
        if (routeInfo) {
            document.getElementById('amb-distance').innerText = routeInfo.distance;
            document.getElementById('amb-eta').innerText = routeInfo.duration;
        }
    }
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
                    if (data.lat && data.lng) {
                        map.setView([data.lat, data.lng], 16);

                        if (markers['selected']) map.removeLayer(markers['selected']);

                        markers['selected'] = L.marker([data.lat, data.lng])
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
                if (!markers[id]) {
                    markers[id] = L.marker([data.lat, data.lng]).addTo(map);
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
                currentState.id = prompt("Enter ambulance ID (example: ambulance1)");
                if (!currentState.id) {
                    // reload if no ID
                    location.reload();
                    return;
                }
            }

            // Hide selector, show specific view
            document.getElementById('view-role-selector').classList.remove('active');
            showView(`view-${role}`);

            if (role !== 'patient') startTracking();

            if (role === 'patient') initPatient();
            if (role === 'ambulance') initAmbulance();
            if (role === 'hospital') initHospital();
            if (role === 'traffic') initTraffic();
        });
    });

});
