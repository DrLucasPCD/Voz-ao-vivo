import { getApps, initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyD1_C9GQjcDCP25B1Bn_tpPWBpHx55LUCo",
  authDomain: "voz-ao-vivo.firebaseapp.com",
  projectId: "voz-ao-vivo",
  storageBucket: "voz-ao-vivo.firebasestorage.app",
  messagingSenderId: "970055294205",
  appId: "1:970055294205:web:3c972504ab958c059a7294",
};

export const firebaseApp = getApps()[0] ?? initializeApp(firebaseConfig);
export const firebaseAuth = getAuth(firebaseApp);
export const firebaseDb = getFirestore(firebaseApp);
export const firebaseStorage = getStorage(firebaseApp);

export const googleAuthProvider = new GoogleAuthProvider();
googleAuthProvider.setCustomParameters({ prompt: "select_account" });
