import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import { getFirestore, collection, doc, onSnapshot, setDoc, deleteDoc, writeBatch } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

// Esta configuración web identifica el proyecto, NO es una contraseña.
// La privacidad depende de Authentication y de las reglas de Firestore.
const firebaseConfig = {
  apiKey: "AIzaSyDvGW-RFyxagytSNNGx4Ac9kmzY8WsHd1Q",
  authDomain: "mi-caja-personal.firebaseapp.com",
  projectId: "mi-caja-personal",
  storageBucket: "mi-caja-personal.firebasestorage.app",
  messagingSenderId: "976077500990",
  appId: "1:976077500990:web:91f9d1406d9816ed04976f"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const gate = document.getElementById("authGate");
const errorBox = document.getElementById("authError");
const status = document.getElementById("syncStatus");
const accountBadge = document.getElementById("accountBadge");
const loginBtn = document.getElementById("loginBtn");
const signupBtn = document.getElementById("signupBtn");
const loginForm = document.getElementById("authForm");

let user = null;
let ready = false;
let unsubscribe = [];
let cloudEntries = [];
let cloudOpening = { cash: 0, bank: 0, wallet: 0 };
let entriesLoaded = false;
let openingLoaded = false;
let configLoaded = false;
let cloudConfig = null;
let hasError = false;

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}
function clearError() {
  errorBox.textContent = "";
  errorBox.hidden = true;
}
function friendlyError(err) {
  const code = err?.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password")) return "Correo o contraseña incorrectos.";
  if (code.includes("email-already-in-use")) return "Ese correo ya tiene una cuenta. Elegí Ingresar.";
  if (code.includes("weak-password")) return "Elegí una contraseña más segura (al menos 6 caracteres).";
  if (code.includes("invalid-email")) return "Revisá la dirección de correo electrónico.";
  if (code.includes("operation-not-allowed")) return "Falta activar Correo/contraseña en Firebase Authentication.";
  if (code.includes("unauthorized-domain")) return "Agregá colormancinelli-cmd.github.io en los dominios autorizados de Firebase Authentication.";
  if (code.includes("permission-denied")) return "Firestore bloqueó el acceso. Revisá y publicá las reglas de seguridad del archivo REGLAS_FIRESTORE.txt.";
  if (code.includes("unavailable") || !navigator.onLine) return "No hay conexión con Firebase. Revisá Internet e intentá de nuevo.";
  return "No se pudo completar la operación. " + (err?.message || code);
}
function showGate(msg) {
  ready = false;
  document.body.classList.add("cloud-locked");
  gate.hidden = false;
  status.textContent = msg;
}
function reportCloudError(err) {
  hasError = true;
  console.error("Mi Caja / Firebase:", err);
  showGate("Sin conexión con la base de datos");
  showError(friendlyError(err));
}
function publish() {
  if (!user || hasError || !entriesLoaded || !openingLoaded || !configLoaded) return;
  ready = true;
  gate.hidden = true;
  document.body.classList.remove("cloud-locked");
  accountBadge.textContent = user.email || "Mi cuenta";
  status.textContent = navigator.onLine ? "● Sincronizado en la nube" : "● Sin conexión";
  window.miCajaUi.applyState({
    version: 1,
    opening: cloudOpening,
    entries: cloudEntries,
    accounts: cloudConfig.accounts,
    categories: cloudConfig.categories
  });
}
function detach() {
  for (const unsub of unsubscribe) try { unsub(); } catch {}
  unsubscribe = [];
  entriesLoaded = false;
  openingLoaded = false;
  configLoaded = false;
  cloudConfig = null;
  cloudEntries = [];
  cloudOpening = { cash: 0, bank: 0, wallet: 0 };
  ready = false;
}
function validRemoteEntry(item) {
  return item && typeof item.id === "string" && /^[^\x00-\x1f/]{1,180}$/.test(item.id) &&
    ["income","expense","transfer"].includes(item.type) &&
    Number.isSafeInteger(item.amount) && item.amount > 0 &&
    typeof item.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.date) &&
    typeof item.description === "string" && typeof item.category === "string" &&
    typeof item.account === 'string' && /^[a-zA-Z0-9_-]{1,50}$/.test(item.account) &&
    (item.type !== "transfer" || typeof item.toAccount === 'string' && /^[a-zA-Z0-9_-]{1,50}$/.test(item.toAccount));
}
function validConfig(c) {
 const ids=new Set();
 return c&&Array.isArray(c.accounts)&&c.accounts.length>=1&&c.accounts.length<=40&&
 c.accounts.every(a=>a&&typeof a.id==='string'&&/^[a-zA-Z0-9_-]{1,50}$/.test(a.id)&&
 typeof a.name==='string'&&a.name.length>=1&&a.name.length<=50&&typeof a.emoji==='string'&&a.emoji.length<=8&&!ids.has(a.id)&&!!ids.add(a.id))&&
 c.categories&&['expense','income'].every(t=>Array.isArray(c.categories[t])&&c.categories[t].length>=1&&c.categories[t].length<=80&&
 c.categories[t].every(x=>typeof x==='string'&&x.length>=1&&x.length<=50));
}
function validOpening(o) {
  return o && Object.values(o).every(v => Number.isSafeInteger(v) && Math.abs(v)<1e13);
}
function attach(uid) {
  detach();
  hasError = false;
  clearError();
  showGate("Cargando tus movimientos…");
  try {
    unsubscribe.push(onSnapshot(collection(db, "users", uid, "entries"), snap => {
      const rows = snap.docs.map(d => ({ ...d.data(), id: d.id }));
      if (!rows.every(validRemoteEntry)) {
        reportCloudError(new Error("Se encontró un movimiento con datos inválidos."));
        return;
      }
      cloudEntries = rows;
      entriesLoaded = true;
      publish();
    }, reportCloudError));
    unsubscribe.push(onSnapshot(doc(db,"users",uid,"meta","config"), snap => {
      const defaults={accounts:[{id:'cash',name:'Efectivo',emoji:'💵'},{id:'bank',name:'Banco',emoji:'🏦'},{id:'wallet',name:'Billetera',emoji:'📱'}],categories:{expense:['Supermercado','Comida','Transporte','Hogar','Servicios','Salud','Salidas','Compras','Educación','Otros'],income:['Sueldo','Ventas','Reintegros','Regalos','Otros']}};
      const c=snap.exists()?snap.data():defaults;
      if(!validConfig(c)){reportCloudError(new Error('Configuración inválida'));return}
      cloudConfig=c;configLoaded=true;publish();
    },reportCloudError));
    unsubscribe.push(onSnapshot(doc(db, "users", uid, "meta", "opening"), snap => {
      const opening = snap.exists() ? snap.data() : { cash: 0, bank: 0, wallet: 0 };
      if (!validOpening(opening)) {
        reportCloudError(new Error("Los saldos iniciales no tienen un formato válido."));
        return;
      }
      cloudOpening = {...opening};
      openingLoaded = true;
      publish();
    }, reportCloudError));
  } catch (err) {
    reportCloudError(err);
  }
}

onAuthStateChanged(auth, nextUser => {
  detach();
  user = nextUser;
  if (user) {
    attach(user.uid);
  } else {
    document.body.classList.add("cloud-locked");
    gate.hidden = false;
    status.textContent = "● Ingresá para sincronizar";
    accountBadge.textContent = "";
    window.miCajaUi.applyState({version: 1, opening: {cash:0,bank:0,wallet:0}, entries: []});
    showGate("Ingresá con tu cuenta para acceder a tus gastos");
  }
}, err => {
  reportCloudError(err);
});

loginForm.addEventListener("submit", async ev => {
  ev.preventDefault();
  clearError();
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  loginBtn.disabled = true;
  signupBtn.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, email, password);
    document.getElementById("authPassword").value = "";
  } catch (err) {
    showError(friendlyError(err));
  } finally {
    loginBtn.disabled = false;
    signupBtn.disabled = false;
  }
});
signupBtn.addEventListener("click", async () => {
  clearError();
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  if (!email || password.length < 6) {
    showError("Ingresá tu correo y una contraseña de al menos 6 caracteres.");
    return;
  }
  loginBtn.disabled = true;
  signupBtn.disabled = true;
  try {
    await createUserWithEmailAndPassword(auth, email, password);
    document.getElementById("authPassword").value = "";
  } catch (err) {
    showError(friendlyError(err));
  } finally {
    loginBtn.disabled = false;
    signupBtn.disabled = false;
  }
});
document.getElementById("signOutBtn").addEventListener("click", async () => {
  detach();
  await signOut(auth);
});
window.addEventListener("online", () => { if (ready) status.textContent = "● Sincronizado en la nube"; });
window.addEventListener("offline", () => { if (ready) status.textContent = "● Sin conexión"; });

function checkReady() {
  if (!ready || !user || hasError) throw new Error("Esperá a que Mi Caja se conecte a Firebase.");
  if (!navigator.onLine) throw new Error("Conectate a Internet para guardar movimientos sincronizados.");
}
function entryDoc(id) {
  if (typeof id !== "string" || !/^[^\x00-\x1f/]{1,180}$/.test(id)) {
    throw new Error("El identificador del movimiento no es válido.");
  }
  return doc(db, "users", user.uid, "entries", id);
}
window.miCajaCloud = {
  errorText: friendlyError,
  async saveEntry(entry) {
    checkReady();
    if (!validRemoteEntry(entry)) throw new Error("Revisá los datos del movimiento.");
    await setDoc(entryDoc(entry.id), entry);
  },
  async removeEntry(id) {
    checkReady();
    await deleteDoc(entryDoc(id));
  },
  async saveOpening(opening) {
    checkReady();
    if (!validOpening(opening)) throw new Error("Los saldos iniciales no son válidos.");
    await setDoc(doc(db,"users",user.uid,"meta","opening"), opening);
  },
  async importEntries(entries, opening) {
    checkReady();
    if (!Array.isArray(entries) || !entries.every(validRemoteEntry)) throw new Error("Los movimientos importados no son válidos.");
    if (opening !== null && !validOpening(opening)) throw new Error("Los saldos iniciales no son válidos.");
    // En lotes: no borrar datos previos ni superar el máximo de operaciones por lote.
    const tasks = entries.map(e => ({ type: "set", entry: e }));
    if (opening !== null) tasks.push({ type: "opening", opening });
    for (let i = 0; i < tasks.length; i += 400) {
      const batch = writeBatch(db);
      for (const task of tasks.slice(i, i + 400)) {
        if (task.type === "opening") batch.set(doc(db, "users", user.uid, "meta", "opening"), task.opening);
        else batch.set(entryDoc(task.entry.id), task.entry);
      }
      await batch.commit();
    }
  },
  async saveConfig(patch,renameEntries=[]) {
    checkReady();
    const config={...cloudConfig,...patch};
    if(!validConfig(config))throw new Error("Configuración inválida.");
    for(const a of cloudConfig.accounts){
      if(!config.accounts.some(b=>b.id===a.id) && (cloudEntries.some(e=>e.account===a.id||e.toAccount===a.id)||cloudOpening[a.id]))throw new Error("La cuenta todavía se utiliza.");
    }
    if(renameEntries.length>350)throw new Error("Hay muchos movimientos para renombrar de una vez. Solicitá una migración por lotes.");
    const batch=writeBatch(db);
    for(const e of renameEntries){
      if(!validRemoteEntry(e))throw new Error("Movimiento inválido.");
      batch.set(entryDoc(e.id),e);
    }
    batch.set(doc(db,"users",user.uid,"meta","config"),config);
    await batch.commit();
  },
  async deleteAll(entries) {
    checkReady();
    const ids = entries.map(e => e.id);
    for (let i = 0; i < ids.length; i += 400) {
      const batch = writeBatch(db);
      for (const id of ids.slice(i, i + 400)) batch.delete(entryDoc(id));
      await batch.commit();
    }
    await setDoc(doc(db, "users", user.uid, "meta", "opening"), {cash:0,bank:0,wallet:0});
  }
};