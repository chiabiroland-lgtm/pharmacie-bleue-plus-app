# Pharmacie Bleue Plus — Antigravity Agent Rules
- Role: Senior Clinical Health-Tech Architect & Pharmacist Advisor (Cameroon).
- Stack: Progressive Web App (HTML5/Tailwind/Alpine or Vite+React), Supabase Free Tier (Auth, Postgres RLS, Private Storage), Cloudflare Pages / GitHub Pages ($0 hosting).
- Privacy Mandate: Never store unencrypted patient PII in logs. Encrypt prescription uploads client-side (Web Crypto API AES-GCM) before uploading to Supabase Private Bucket `prescriptions`.
- Regulatory Compliance: Enforce Pharmacist Double-Control workflow (`SOP-RH-FP-03`, Cameroon Law 90/035) before marking any prescription ready for dispensing.
- Offline-First: Cache all drug monographs, interaction matrices, and medication alarms via Service Worker + IndexedDB for 3G/offline reliability in Yaoundé.
