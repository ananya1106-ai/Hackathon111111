import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import {
  getAuth,
  Auth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  sendEmailVerification,
  applyActionCode,
  checkActionCode,
  reload,
  sendPasswordResetEmail,
  ActionCodeSettings,
  User as FirebaseUser,
} from 'firebase/auth';
import {
  getFirestore,
  Firestore,
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  updateDoc,
  collection,
  query,
  onSnapshot,
  runTransaction,
  getDocs,
  where,
  orderBy,
  limit,
  addDoc,
  deleteDoc,
  serverTimestamp,
  DocumentData,
  QuerySnapshot,
  Unsubscribe,
} from 'firebase/firestore';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export interface FirebaseConnectionStatus {
  isConfigured: boolean;
  isConnected: boolean;
  projectId: string;
  authDomain: string;
  error?: string;
  missingKeys: string[];
  isDatabaseMissing?: boolean;
  setupUrl?: string;
  setupInstructions?: string;
}

// 1. Web App configuration values from Vite environment variables or defaults for project 'smartipds'
const env = (typeof import.meta !== 'undefined' && import.meta.env && Object.keys(import.meta.env).length > 0)
  ? (import.meta.env as Record<string, string>)
  : (typeof process !== 'undefined' && process.env ? (process.env as unknown as Record<string, string>) : ({} as Record<string, string>));

export const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || '',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || 'smartipds.firebaseapp.com',
  projectId: env.VITE_FIREBASE_PROJECT_ID || 'smartipds',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || 'smartipds.firebasestorage.app',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  appId: env.VITE_FIREBASE_APP_ID || '',
};

// Required environment variable names for Firebase Web connection
export const REQUIRED_FIREBASE_ENV_VARS = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID',
] as const;

export const OPTIONAL_FIREBASE_ENV_VARS = [
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
] as const;

// Safe environment variable audit: Identifies only the names of missing or placeholder variables.
// Never prints or exposes the actual variable values.
export const missingEnvVarNames = REQUIRED_FIREBASE_ENV_VARS.filter((varName) => {
  const val = env[varName];
  return !val || val.trim() === '' || val.startsWith('YOUR_') || val.includes('placeholder');
});

export const missingConfigKeys = missingEnvVarNames;
export const isFirebaseConfigured = missingEnvVarNames.length === 0;

export interface SafeFirebaseDiagnostic {
  targetProjectId: string;
  isConfigured: boolean;
  missingEnvVarNames: string[];
  lastErrorCode: string | null;
}

export function getSafeFirebaseDiagnostic(lastErrorCode?: string | null): SafeFirebaseDiagnostic {
  return {
    targetProjectId: firebaseConfig.projectId || 'smartipds',
    isConfigured: isFirebaseConfigured,
    missingEnvVarNames: [...missingEnvVarNames],
    lastErrorCode: lastErrorCode || null,
  };
}

// 2. Initialize Firebase App safely without crashing if config is pending
let app: FirebaseApp;
if (getApps().length > 0) {
  app = getApp();
} else {
  app = initializeApp(
    isFirebaseConfigured
      ? firebaseConfig
      : {
          apiKey: firebaseConfig.apiKey || 'placeholder-api-key-smartipds',
          authDomain: firebaseConfig.authDomain || 'smartipds.firebaseapp.com',
          projectId: 'smartipds',
          storageBucket: 'smartipds.firebasestorage.app',
          appId: firebaseConfig.appId || '1:000000000000:web:0000000000000000000000',
        }
  );
}

// 3. Centralized Auth and Cloud Firestore instances
export const auth: Auth = getAuth(app);
export const db: Firestore = getFirestore(app);

// 4. Standardized Firestore Error Handler
export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('[SmartPDS Firestore Error]:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// 5. Verification Test Operation to Cloud Firestore
export async function testFirestoreConnection(): Promise<FirebaseConnectionStatus> {
  const status: FirebaseConnectionStatus = {
    isConfigured: isFirebaseConfigured,
    isConnected: false,
    projectId: firebaseConfig.projectId,
    authDomain: firebaseConfig.authDomain,
    missingKeys: missingConfigKeys,
  };

  if (!isFirebaseConfigured) {
    status.error = `Firebase configuration incomplete. Missing: ${missingConfigKeys.join(', ')}`;
    return status;
  }

  // Fast direct REST query: check if the (default) database exists on Google Cloud
  try {
    const restEndpoint = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/test/connection?key=${firebaseConfig.apiKey}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(restEndpoint, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (res.status === 404) {
      const errBody = await res.json().catch(() => ({}));
      const msg = errBody?.error?.message || '';
      if (msg.includes('database (default) does not exist') || msg.includes('does not exist for project')) {
        status.isConnected = false;
        status.isDatabaseMissing = true;
        status.error = `The database (default) does not exist for project ${firebaseConfig.projectId}.`;
        status.setupUrl = `https://console.firebase.google.com/project/${firebaseConfig.projectId}/firestore`;
        status.setupInstructions = `1. Open Firebase Console (https://console.firebase.google.com/project/${firebaseConfig.projectId}/firestore)\n2. Click "Create database"\n3. Select "Production mode" and choose a region (e.g. asia-south1 or us-central1)\n4. Click "Enable" / "Create"`;
        console.warn('[SmartPDS Firebase]:', status.error);
        return status;
      }
    } else if (res.status === 200 || res.status === 403) {
      // 200 or 403 (PERMISSION_DENIED) confirms the database exists and responded to the query!
      status.isConnected = true;
      status.isDatabaseMissing = false;
      console.log('[SmartPDS Firebase]: Cloud Firestore endpoint reached (authenticated rule response).');
      return status;
    }
  } catch (restErr: any) {
    console.warn('[SmartPDS Firebase]: Direct REST check skipped or timed out:', restErr?.message || restErr);
  }

  // Secondary Web SDK check
  try {
    const testDocRef = doc(db, 'test', 'connection');
    await getDocFromServer(testDocRef);
    status.isConnected = true;
    status.isDatabaseMissing = false;
    console.log('[SmartPDS Firebase]: Connected successfully to Cloud Firestore (project: smartipds).');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    status.error = msg;
    if (msg.includes('database (default) does not exist') || msg.includes('does not exist for project') || (error as any)?.code === 'not-found') {
      status.isConnected = false;
      status.isDatabaseMissing = true;
      status.error = `The database (default) does not exist for project ${firebaseConfig.projectId}.`;
      status.setupUrl = `https://console.firebase.google.com/project/${firebaseConfig.projectId}/firestore`;
      status.setupInstructions = `Please visit https://console.firebase.google.com/project/${firebaseConfig.projectId}/firestore to create the default Cloud Firestore database.`;
      console.warn('[SmartPDS Firebase]: Database (default) does not exist in project:', firebaseConfig.projectId);
    } else if (msg.includes('permission-denied') || msg.includes('Missing or insufficient permissions')) {
      status.isConnected = true;
      status.isDatabaseMissing = false;
      console.log('[SmartPDS Firebase]: Cloud Firestore endpoint reached (authenticated rule response).');
    } else {
      console.error('[SmartPDS Firebase]: Connection test failed:', msg);
    }
  }

  return status;
}

/**
 * Generates official ActionCodeSettings for SmartPDS email verification.
 * Dynamically resolves the active deployed application origin (window.location.origin)
 * so verification links return directly to the live app terminal instead of the unhosted Firebase default domain.
 */
export function getActionCodeSettings(): ActionCodeSettings {
  let appUrl = '';
  if (typeof window !== 'undefined' && window.location && window.location.origin) {
    appUrl = window.location.origin;
  }
  if (!appUrl) {
    appUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_APP_URL) || 'https://smartipds.firebaseapp.com';
  }

  const cleanBase = appUrl.replace(/\/+$/, '');
  return {
    url: `${cleanBase}/?mode=verifyEmail`,
    handleCodeInApp: false,
  };
}

export {
  app,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  firebaseSignOut,
  onAuthStateChanged,
  sendEmailVerification,
  applyActionCode,
  checkActionCode,
  reload,
  sendPasswordResetEmail,
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  updateDoc,
  collection,
  query,
  onSnapshot,
  runTransaction,
  getDocs,
  where,
  orderBy,
  limit,
  addDoc,
  deleteDoc,
  serverTimestamp,
};
export type { FirebaseUser, DocumentData, QuerySnapshot, Unsubscribe, ActionCodeSettings };

