# The Better Kids Clinic EMR

Standalone Vite web app for The Better Kids Clinic EMR.

## Local development

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file from `.env.example` and fill in the cloud service values.

3. Start the dev server:

```bash
npm run dev
```

## Vercel deployment

Deploy this folder as its own Vercel project. It is configured to be served from `/emr/kid`, so the public URL is:

```bash
https://www.thebetterhealth.clinic/emr/kid/
```

Set the Vercel Root Directory to:

```bash
emr/kid
```

Set these environment variables in the Vercel project settings before deploying:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_FIREBASE_MEASUREMENT_ID`
- `CLINIC_ACCESS_PASSWORD`
- `CLINIC_SESSION_SECRET`

`CLINIC_ACCESS_PASSWORD` is the actual clinic login password. `CLINIC_SESSION_SECRET` should be a long random secret used to sign the secure session cookie.

Build command:

```bash
npm run build
```

Output directory:

```bash
dist
```
