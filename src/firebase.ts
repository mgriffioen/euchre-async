import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDaZYR-o_fS_6vXqM8M8zXTTuu6a-ElMXc",
  authDomain: "euchre-40bdd.firebaseapp.com",
  projectId: "euchre-40bdd",
  storageBucket: "euchre-40bdd.firebasestorage.app",
  messagingSenderId: "253278804055",
  appId: "1:253278804055:web:e0f9e6f6f1bad6258beb12",
  measurementId: "G-XPHTMKXWZ2"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);