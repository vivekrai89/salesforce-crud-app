# Salesforce CRUD App

React + Express app for CRUD on Account, Opportunity, Lead, Contact and Case.
Login uses OAuth 2.0 Authorization Code flow with PKCE through a Salesforce External Client App.
Tokens stay on the server (session); the browser never sees them.

## Run locally
1. `cp .env.example .env` and fill in the values from your External Client App.
2. `npm install && npm run build && npm start`
3. Open http://localhost:3000

## Deploy (Render, free web service)
- Build command: `npm install && npm run build`
- Start command: `npm start`
- Environment variables: same as `.env.example`, with `SF_CALLBACK_URL=https://<your-app>.onrender.com/auth/callback` and `NODE_ENV=production`
- Add the same callback URL in the External Client App.
