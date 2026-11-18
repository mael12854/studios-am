import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const ISSUER_ID = Deno.env.get("GOOGLE_WALLET_ISSUER_ID")!;
const SERVICE_ACCOUNT_EMAIL = Deno.env.get("GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL")!;
const SERVICE_ACCOUNT_PRIVATE_KEY_RAW = Deno.env.get("GOOGLE_WALLET_SERVICE_ACCOUNT_PRIVATE_KEY")!;
const SITE_ORIGIN = "https://studios-am.vercel.app";

const INK = "#38332A";

function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = "";
  for (const b of arr) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
  const b64 = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function signJwt(payload: Record<string, unknown>, privateKey: CryptoKey): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const encoder = new TextEncoder();
  const headerPart = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadPart = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerPart}.${payloadPart}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function getAccessToken(privateKey: CryptoKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signJwt(
    {
      iss: SERVICE_ACCOUNT_EMAIL,
      scope: "https://www.googleapis.com/auth/wallet_object.issuer",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    },
    privateKey,
  );

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!res.ok) {
    throw new Error(`OAuth token exchange failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token as string;
}

async function ensureClassExists(accessToken: string, classId: string) {
  const res = await fetch("https://walletobjects.googleapis.com/walletobjects/v1/genericClass", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: classId,
      issuerName: "Les studios A&M",
      reviewStatus: "UNDER_REVIEW",
      hexBackgroundColor: INK,
    }),
  });
  // 409 = la classe existe deja, c'est le cas normal apres le premier appel.
  if (!res.ok && res.status !== 409) {
    throw new Error(`Creation de la classe Wallet echouee (${res.status}): ${await res.text()}`);
  }
}

async function upsertObject(accessToken: string, object: Record<string, unknown>) {
  const res = await fetch("https://walletobjects.googleapis.com/walletobjects/v1/genericObject", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(object),
  });
  if (res.ok) return;
  if (res.status === 409) {
    // Deja cree : on le met a jour pour refleter d'eventuels changements (lieu, date...).
    const id = object.id as string;
    const putRes = await fetch(
      `https://walletobjects.googleapis.com/walletobjects/v1/genericObject/${encodeURIComponent(id)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(object),
      },
    );
    if (!putRes.ok) {
      throw new Error(`Mise a jour du pass Wallet echouee (${putRes.status}): ${await putRes.text()}`);
    }
    return;
  }
  throw new Error(`Creation du pass Wallet echouee (${res.status}): ${await res.text()}`);
}

function formatDateFR(isoDate: string | null): string {
  if (!isoDate) return "Date a confirmer";
  const d = new Date(isoDate + "T00:00:00");
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

Deno.serve(async (req: Request) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Methode non supportee" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Non authentifie" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { reservation_id } = await req.json();
    if (!reservation_id) {
      return new Response(JSON.stringify({ error: "reservation_id manquant" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Client scope a l'utilisateur appelant : la lecture respecte les RLS existantes
    // (le proprietaire de la reservation ou un admin seulement).
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: reservation, error } = await sb
      .from("ticket_reservations")
      .select("*, articles(title, date_representation, lieu)")
      .eq("id", reservation_id)
      .maybeSingle();

    if (error || !reservation) {
      return new Response(JSON.stringify({ error: "Reservation introuvable ou acces refuse" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: userData } = await sb.auth.getUser();
    const meta = userData?.user?.user_metadata as { prenom?: string; nom?: string } | undefined;
    const clientName = reservation.label ||
      (meta?.prenom && meta?.nom ? `${meta.prenom} ${meta.nom}` : userData?.user?.email) ||
      "Titulaire";

    const privateKey = await pemToPrivateKey(SERVICE_ACCOUNT_PRIVATE_KEY_RAW);
    const accessToken = await getAccessToken(privateKey);

    const classId = `${ISSUER_ID}.studios_am_billet`;
    const safeSuffix = String(reservation_id).replace(/[^A-Za-z0-9_.-]/g, "");
    const objectId = `${ISSUER_ID}.billet_${safeSuffix}`;
    const articleTitle = reservation.articles?.title || "Evenement";
    const validationUrl = `${SITE_ORIGIN}/admin/validation.html?id=${reservation.id}`;

    await ensureClassExists(accessToken, classId);

    const isFree = !reservation.unlimited && Number(reservation.unit_price) === 0;
    const statusText = reservation.unlimited
      ? "Illimite — entrees multiples autorisees"
      : isFree
      ? "Gratuit — rien a regler"
      : reservation.paid
      ? "Paye"
      : "A regler sur place";

    const genericObject = {
      id: objectId,
      classId,
      state: "ACTIVE",
      hexBackgroundColor: INK,
      cardTitle: { defaultValue: { language: "fr-FR", value: "Les studios A&M" } },
      header: { defaultValue: { language: "fr-FR", value: articleTitle } },
      subheader: { defaultValue: { language: "fr-FR", value: statusText } },
      barcode: { type: "QR_CODE", value: validationUrl },
      textModulesData: [
        { id: "date", header: "Date", body: formatDateFR(reservation.articles?.date_representation) },
        { id: "lieu", header: "Lieu", body: reservation.articles?.lieu || "A confirmer, voir le site" },
        { id: "titulaire", header: "Titulaire", body: String(clientName) },
        { id: "places", header: "Places", body: `${reservation.quantity} (dont ${reservation.minors || 0} mineur(s))` },
      ],
    };

    await upsertObject(accessToken, genericObject);

    const saveJwt = await signJwt(
      {
        iss: SERVICE_ACCOUNT_EMAIL,
        aud: "google",
        typ: "savetowallet",
        iat: Math.floor(Date.now() / 1000),
        origins: [SITE_ORIGIN],
        payload: { genericObjects: [{ id: objectId }] },
      },
      privateKey,
    );

    return new Response(JSON.stringify({ saveUrl: `https://pay.google.com/gp/v/save/${saveJwt}` }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
