import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDFSnEpsN16FxGcfUYMcp6b1MsBOurzJzg",
  authDomain: "reservation-98067.firebaseapp.com",
  projectId: "reservation-98067",
  storageBucket: "reservation-98067.firebasestorage.app",
  messagingSenderId: "545855815166",
  appId: "1:545855815166:web:3f47bb2cfdbc1d64fe14af",
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
