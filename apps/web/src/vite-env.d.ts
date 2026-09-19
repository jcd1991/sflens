/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SALESFORCE_CLIENT_ID?: string;
  readonly VITE_SALESFORCE_LOGIN_URL?: string;
  readonly VITE_SALESFORCE_API_VERSION?: string;
  readonly VITE_SFLENS_RELAY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
