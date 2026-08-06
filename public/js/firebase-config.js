import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyBK7IPrIbVAptetVH74L8scrCY2AkFPCSw",
  authDomain: "my-teaching-tools-87a6d.firebaseapp.com",
  projectId: "my-teaching-tools-87a6d",
  storageBucket: "my-teaching-tools-87a6d.firebasestorage.app",
  messagingSenderId: "590095652394",
  appId: "1:590095652394:web:2005cb8ef041b4641e1553",
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
