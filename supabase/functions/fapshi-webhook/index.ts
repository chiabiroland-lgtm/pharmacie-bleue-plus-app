// ==============================================================================
// Pharmacie Bleue Plus — Fapshi Mobile Money Payment Webhook Edge Function
// Stack: Supabase Edge Functions (Deno / TypeScript)
// Gateway: Fapshi (MTN Mobile Money & Orange Money Cameroon)
// Security: x-wh-secret header verification & Zero-PII telecom logging
// Action: Flips patient membership tier in public.profiles from FREE to PRO
// ==============================================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-wh-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

interface FapshiWebhookPayload {
  transId: string;
  status: "SUCCESSFUL" | "FAILED" | "EXPIRED" | "CREATED" | "PENDING";
  medium?: string;
  serviceName?: string;
  transType?: string;
  amount: number;
  revenue?: number;
  payerName?: string;
  email?: string;
  redirectUrl?: string;
  externalId: string;
  userId?: string;
  financialTransId?: string;
  dateInitiated?: string;
  dateConfirmed?: string;
  reason?: string;
}

serve(async (req: Request) => {
  // 1. Handle CORS Preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 2. Enforce HTTP POST
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed. Use POST." }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    // 3. Security Check: Verify Fapshi Webhook Secret Header (x-wh-secret)
    const expectedSecret = Deno.env.get("FAPSHI_WEBHOOK_SECRET");
    const incomingSecret = req.headers.get("x-wh-secret");

    if (!expectedSecret) {
      console.error("[CRITICAL] FAPSHI_WEBHOOK_SECRET environment secret is not configured in Supabase.");
      return new Response(
        JSON.stringify({ error: "Server misconfiguration: Webhook secret not set." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!incomingSecret || incomingSecret !== expectedSecret) {
      console.warn(`[UNAUTHORIZED] Webhook attempt rejected: Invalid or missing x-wh-secret header.`);
      return new Response(
        JSON.stringify({ error: "Unauthorized: Invalid or missing x-wh-secret header." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 4. Parse & Validate Incoming Fapshi Payload
    const payload: FapshiWebhookPayload = await req.json();

    if (!payload.transId || !payload.status || !payload.externalId) {
      return new Response(
        JSON.stringify({ error: "Invalid payload: missing transId, status, or externalId." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[FAPSHI WEBHOOK] Received transaction ${payload.transId} | Status: ${payload.status} | ExternalId: ${payload.externalId} | Medium: ${payload.medium || 'momo'}`);

    // 5. Initialize Supabase Admin Client with Service Role (Bypasses Client RLS)
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error("[CRITICAL] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
      return new Response(
        JSON.stringify({ error: "Server misconfiguration: Database credentials missing." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const nowIso = new Date().toISOString();
    const isSuccess = payload.status === "SUCCESSFUL";

    // 6. Record Transaction in public.payments (Zero-PII: No plaintext patient names or phone numbers)
    const paymentRecord = {
      trans_id: payload.transId,
      external_id: payload.externalId,
      amount: payload.amount || 2500.0,
      currency: "XAF",
      medium: payload.medium || "mobile money",
      financial_trans_id: payload.financialTransId || null,
      status: payload.status,
      confirmed_at: payload.dateConfirmed || nowIso,
      raw_payload: {
        transId: payload.transId,
        status: payload.status,
        medium: payload.medium,
        amount: payload.amount,
        financialTransId: payload.financialTransId,
        dateInitiated: payload.dateInitiated,
        dateConfirmed: payload.dateConfirmed
      }
    };

    // Ensure profile exists first to satisfy foreign key constraint
    const { error: profileInitErr } = await supabase
      .from("profiles")
      .upsert(
        {
          external_id: payload.externalId,
          updated_at: nowIso
        },
        { onConflict: "external_id", ignoreDuplicates: true }
      );

    if (profileInitErr) {
      console.warn(`[WARN] Profile initialization notice for ${payload.externalId}:`, profileInitErr.message);
    }

    // Upsert payment audit row
    const { error: paymentErr } = await supabase
      .from("payments")
      .upsert(paymentRecord, { onConflict: "trans_id" });

    if (paymentErr) {
      console.error(`[ERROR] Failed to record payment ${payload.transId}:`, paymentErr);
      return new Response(
        JSON.stringify({ error: "Failed to persist payment audit record." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 7. If Payment SUCCESSFUL: Flip Patient Profile Tier from FREE to PRO (Care+ VIP)
    if (isSuccess) {
      // Grant 30 days of Care+ VIP access
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      const { data: updatedProfile, error: tierErr } = await supabase
        .from("profiles")
        .update({
          tier: "PRO",
          pro_since: nowIso,
          pro_expires_at: expiresAt,
          updated_at: nowIso
        })
        .eq("external_id", payload.externalId)
        .select()
        .single();

      if (tierErr) {
        console.error(`[ERROR] Failed to flip tier to PRO for ${payload.externalId}:`, tierErr);
        return new Response(
          JSON.stringify({ error: "Payment recorded but failed to upgrade tier." }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      console.log(`[TIER UPGRADE] Successfully upgraded patient ${payload.externalId} to PRO (Expires: ${expiresAt}) via ${payload.medium || 'MTN/Orange MoMo'}.`);

      return new Response(
        JSON.stringify({
          success: true,
          message: "Payment confirmed. Patient tier upgraded to PRO (Bleue Plus Care+ VIP).",
          transId: payload.transId,
          tier: "PRO",
          expiresAt
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 8. If Payment FAILED / EXPIRED
    console.log(`[PAYMENT NOT CONFIRMED] Transaction ${payload.transId} ended with status: ${payload.status}`);
    return new Response(
      JSON.stringify({
        success: true,
        message: `Transaction processed with status: ${payload.status}. No tier modification made.`,
        transId: payload.transId,
        status: payload.status
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[FATAL ERROR] Fapshi webhook unhandled exception:", errorMsg);
    return new Response(
      JSON.stringify({ error: "Internal Server Error", detail: errorMsg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
