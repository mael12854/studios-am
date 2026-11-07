/* Standard téléphonique des studios A&M — widget visiteur.
   Arbre de menus vocal : modifiable ci-dessous dans MENU_TREE. */
(function () {
    if (typeof sb === "undefined") return;

    var SITE_PROGRAMMATION_URL = "films.html";
    var SITE_RESERVATIONS_URL = "panier.html";
    var CALL_TIMEOUT_MS = 30000;

    var MENU_TREE = {
        root: {
            label: "Menu principal",
            greeting: "Bienvenue aux studios A et M. Tapez 1 pour la programmation, 2 pour les réservations, 3 pour rejoindre la troupe, ou 0 pour être mis en relation avec quelqu'un.",
            options: { "1": "programmation", "2": "reservations", "3": "casting" }
        },
        programmation: {
            label: "Programmation",
            dynamic: true
        },
        reservations: {
            label: "Réservations",
            greeting: "Pour réserver vos places, rendez-vous sur la page Réservations du site. Tapez étoile pour revenir au menu, ou zéro pour parler à quelqu'un."
        },
        casting: {
            label: "Castings",
            greeting: "Pour rejoindre la troupe ou passer un casting, laissez-nous un message en tapant zéro, et nous vous recontacterons. Tapez étoile pour revenir au menu."
        }
    };

    var state = "idle"; // idle | menu | calling | connecting | in-call | voicemail
    var currentNode = "root";
    var callId = null;
    var callTimeoutId = null;
    var callStartedAt = null;
    var timerIntervalId = null;
    var pc = null;
    var localStream = null;
    var pendingIce = [];
    var standardChannel = null;
    var callChannel = null;

    function escapeHtml(str) {
        var div = document.createElement("div");
        div.textContent = str == null ? "" : str;
        return div.innerHTML;
    }

    function formatDateFR(isoDate) {
        if (!isoDate) return null;
        var d = new Date(isoDate + "T00:00:00");
        return d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
    }

    /* ---- synthèse vocale + écran ---- */
    function speak(text) {
        setScreen(text);
        try {
            if (!("speechSynthesis" in window)) return;
            window.speechSynthesis.cancel();
            var utter = new SpeechSynthesisUtterance(text);
            utter.lang = "fr-FR";
            utter.rate = 0.95;
            window.speechSynthesis.speak(utter);
        } catch (e) {}
    }

    function stopSpeaking() {
        try { if ("speechSynthesis" in window) window.speechSynthesis.cancel(); } catch (e) {}
    }

    function setScreen(text) {
        var el = document.getElementById("amPhoneScreen");
        if (el) el.textContent = text;
    }

    function setSubScreen(text) {
        var el = document.getElementById("amPhoneSubScreen");
        if (el) el.textContent = text || "";
    }

    /* ---- musique d'attente (Web Audio, generee) ---- */
    var holdCtx = null, holdGain = null, holdIntervalId = null;
    function startHoldMusic() {
        try {
            holdCtx = new (window.AudioContext || window.webkitAudioContext)();
            holdGain = holdCtx.createGain();
            holdGain.gain.value = 0.04;
            holdGain.connect(holdCtx.destination);
            var notes = [440.0, 523.25, 659.25, 523.25];
            var i = 0;
            holdIntervalId = setInterval(function () {
                if (!holdCtx) return;
                var osc = holdCtx.createOscillator();
                osc.type = "sine";
                osc.frequency.value = notes[i % notes.length];
                osc.connect(holdGain);
                osc.start();
                osc.stop(holdCtx.currentTime + 0.35);
                i++;
            }, 550);
        } catch (e) {}
    }
    function stopHoldMusic() {
        if (holdIntervalId) clearInterval(holdIntervalId);
        holdIntervalId = null;
        if (holdCtx) { try { holdCtx.close(); } catch (e) {} holdCtx = null; }
    }

    /* ---- chrono d'appel ---- */
    function startTimer() {
        callStartedAt = Date.now();
        timerIntervalId = setInterval(function () {
            var secs = Math.floor((Date.now() - callStartedAt) / 1000);
            var mm = String(Math.floor(secs / 60)).padStart(2, "0");
            var ss = String(secs % 60).padStart(2, "0");
            setSubScreen(mm + ":" + ss);
        }, 1000);
    }
    function stopTimer() {
        if (timerIntervalId) clearInterval(timerIntervalId);
        timerIntervalId = null;
        setSubScreen("");
    }

    /* ---- UI : bouton flottant + telephone ---- */
    function injectStyles() {
        var style = document.createElement("style");
        style.textContent = [
            "#amCallBtn{position:fixed;left:1rem;bottom:1rem;z-index:1000;box-shadow:var(--shadow-sm);}",
            "#amPhoneOverlay{position:fixed;inset:0;background:rgba(26,24,22,.55);display:none;align-items:center;justify-content:center;z-index:1100;padding:1rem;}",
            "#amPhoneOverlay.active{display:flex;}",
            "#amPhone{width:100%;max-width:320px;text-align:center;}",
            "#amPhone h3{margin:0 0 .75rem;font-size:1rem;}",
            "#amPhoneDisplay{background:var(--surface-alt);border:1px solid var(--line);border-radius:var(--radius-sm);padding:.75rem;margin-bottom:1rem;min-height:4.5rem;}",
            "#amPhoneScreen{font-family:var(--font-mono);font-size:.85rem;line-height:1.4;}",
            "#amPhoneSubScreen{font-family:var(--font-mono);color:var(--gold);font-size:.95rem;margin-top:.35rem;}",
            "#amDialpad{display:grid;grid-template-columns:repeat(3,1fr);gap:.5rem;margin-bottom:1rem;}",
            "#amDialpad button{padding:.75rem 0;font-family:var(--font-mono);font-size:1.05rem;}",
            "#amPhoneActions{display:flex;gap:.5rem;justify-content:center;}",
            "#amPhoneActions .am-hangup{border-color:var(--danger);color:var(--danger);}",
            "#amPhoneActions .am-hangup:hover{background:var(--danger);color:var(--bg);}",
            "#amVoicemailBox{margin-top:1rem;text-align:left;}",
            "#amVoicemailBox textarea{min-height:70px;}"
        ].join("");
        document.head.appendChild(style);
    }

    function injectDom() {
        var btn = document.createElement("button");
        btn.id = "amCallBtn";
        btn.className = "btn btn-primary";
        btn.type = "button";
        btn.textContent = "📞 Appeler les Studios";
        document.body.appendChild(btn);

        var overlay = document.createElement("div");
        overlay.id = "amPhoneOverlay";
        overlay.innerHTML =
            '<div id="amPhone" class="card">' +
                "<h3>Les studios A&amp;M</h3>" +
                '<div id="amPhoneDisplay">' +
                    '<div id="amPhoneScreen">Décrochez pour appeler.</div>' +
                    '<div id="amPhoneSubScreen"></div>' +
                "</div>" +
                '<div id="amDialpad">' +
                    ["1","2","3","4","5","6","7","8","9","*","0","#"].map(function (k) {
                        return '<button type="button" class="btn" data-digit="' + k + '">' + k + "</button>";
                    }).join("") +
                "</div>" +
                '<div id="amPhoneActions">' +
                    '<button type="button" class="btn-primary" id="amPickupBtn">Décrocher</button>' +
                    '<button type="button" class="btn am-hangup" id="amHangupBtn" style="display:none;">Raccrocher</button>' +
                "</div>" +
                '<div id="amVoicemailBox" style="display:none;"></div>' +
            "</div>";
        document.body.appendChild(overlay);

        btn.addEventListener("click", openPhone);
        overlay.addEventListener("click", function (e) { if (e.target === overlay) closePhone(true); });
        document.getElementById("amPickupBtn").addEventListener("click", startCallSession);
        document.getElementById("amHangupBtn").addEventListener("click", function () { closePhone(true); });
        document.getElementById("amDialpad").addEventListener("click", function (e) {
            var btn = e.target.closest("[data-digit]");
            if (btn) handleDigit(btn.dataset.digit);
        });
    }

    function openPhone() {
        document.getElementById("amPhoneOverlay").classList.add("active");
        document.getElementById("amVoicemailBox").style.display = "none";
        document.getElementById("amVoicemailBox").innerHTML = "";
        resetDialUi();
        setScreen("Décrochez pour appeler.");
        setSubScreen("");
    }

    function resetDialUi() {
        document.getElementById("amPickupBtn").style.display = "inline-block";
        document.getElementById("amHangupBtn").style.display = "none";
    }

    function startCallSession() {
        document.getElementById("amPickupBtn").style.display = "none";
        document.getElementById("amHangupBtn").style.display = "inline-block";
        state = "menu";
        currentNode = "root";
        speak(MENU_TREE.root.greeting);
    }

    function closePhone(hangupFully) {
        if (hangupFully) {
            teardownCall();
            stopSpeaking();
            stopHoldMusic();
            if (callTimeoutId) { clearTimeout(callTimeoutId); callTimeoutId = null; }
            if (standardChannel) { sb.removeChannel(standardChannel); standardChannel = null; }
            state = "idle";
            currentNode = "root";
        }
        document.getElementById("amPhoneOverlay").classList.remove("active");
    }

    function handleDigit(digit) {
        if (state === "in-call" || state === "connecting") return;
        if (state !== "menu") return;

        if (digit === "0") {
            requestHuman();
            return;
        }
        if (digit === "*") {
            currentNode = "root";
            speak(MENU_TREE.root.greeting);
            return;
        }
        if (digit === "#") {
            replayCurrent();
            return;
        }

        var node = MENU_TREE[currentNode];
        var target = node && node.options ? node.options[digit] : null;
        if (!target) return;

        currentNode = target;
        var targetNode = MENU_TREE[target];
        if (targetNode.dynamic) {
            speakProgrammation();
        } else {
            speak(targetNode.greeting);
        }
    }

    function replayCurrent() {
        var node = MENU_TREE[currentNode];
        if (currentNode === "programmation") {
            speakProgrammation();
        } else if (node) {
            speak(node.greeting);
        }
    }

    async function speakProgrammation() {
        setScreen("Chargement de la programmation...");
        var res = await sb
            .from("articles")
            .select("title, date_representation, category")
            .eq("status", "publie")
            .order("created_at", { ascending: false })
            .limit(5);

        var data = res.data;
        var text;
        if (!data || data.length === 0) {
            text = "Aucun spectacle n'est actuellement à l'affiche. Revenez bientôt. Tapez étoile pour revenir au menu.";
        } else {
            var items = data.map(function (a) {
                var kind = a.category === "film" ? "le film" : "la pièce";
                var date = a.date_representation ? (", le " + formatDateFR(a.date_representation)) : "";
                return kind + " " + a.title + date;
            });
            text = "Voici notre programmation actuelle : " + items.join(". ") + ". Tapez étoile pour revenir au menu, ou zéro pour parler à quelqu'un.";
        }
        speak(text);
    }

    /* ---- mise en relation avec un admin ---- */
    async function requestHuman() {
        stopSpeaking();
        state = "calling";
        setScreen("Vérification de la disponibilité...");

        var presenceCh = sb.channel("standard-presence");
        var hasAdmin = false;
        presenceCh.subscribe(async function (status) {
            if (status !== "SUBSCRIBED") return;
            var presenceState = presenceCh.presenceState();
            hasAdmin = Object.keys(presenceState).length > 0;
            sb.removeChannel(presenceCh);
            if (!hasAdmin) {
                noAnswerFallback();
                return;
            }
            await launchCallRequest();
        });
    }

    async function launchCallRequest() {
        callId = crypto.randomUUID();
        pendingIce = [];

        callChannel = sb.channel("call-" + callId);
        callChannel.on("broadcast", { event: "answer" }, async function (msg) {
            if (!pc) return;
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(msg.payload.sdp));
                pendingIce.forEach(function (c) { pc.addIceCandidate(new RTCIceCandidate(c)).catch(function () {}); });
                pendingIce = [];
            } catch (e) {}
        });
        callChannel.on("broadcast", { event: "ice" }, function (msg) {
            if (!pc) return;
            if (pc.remoteDescription) {
                pc.addIceCandidate(new RTCIceCandidate(msg.payload.candidate)).catch(function () {});
            } else {
                pendingIce.push(msg.payload.candidate);
            }
        });
        callChannel.on("broadcast", { event: "hangup" }, function () {
            endCallUi("L'appel a été raccroché.");
        });

        await new Promise(function (resolve) { callChannel.subscribe(function (status) { if (status === "SUBSCRIBED") resolve(); }); });

        standardChannel = sb.channel("standard-broadcast");
        standardChannel.on("broadcast", { event: "call_taken" }, function (msg) {
            if (msg.payload.callId !== callId) return;
            if (callTimeoutId) { clearTimeout(callTimeoutId); callTimeoutId = null; }
            stopHoldMusic();
            state = "connecting";
            setScreen("Un conseiller décroche...");
            startWebrtcOffer();
        });

        await new Promise(function (resolve) { standardChannel.subscribe(function (status) { if (status === "SUBSCRIBED") resolve(); }); });

        var { data: { session } } = await sb.auth.getSession();
        var visitorLabel = "Visiteur anonyme";
        if (session && session.user) {
            var meta = session.user.user_metadata || {};
            visitorLabel = (meta.prenom && meta.nom) ? (meta.prenom + " " + meta.nom) : session.user.email;
        }

        standardChannel.send({
            type: "broadcast",
            event: "call_request",
            payload: { callId: callId, choice: MENU_TREE[currentNode] ? MENU_TREE[currentNode].label : "Menu principal", visitorLabel: visitorLabel }
        });

        setScreen("En attente d'un conseiller...");
        startHoldMusic();
        callTimeoutId = setTimeout(noAnswerFallback, CALL_TIMEOUT_MS);
    }

    async function startWebrtcOffer() {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) {
            setScreen("Impossible d'accéder au micro : " + e.message);
            return;
        }

        pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
        localStream.getTracks().forEach(function (t) { pc.addTrack(t, localStream); });
        pc.ontrack = function (event) { playRemoteAudio(event.streams[0]); };
        pc.onicecandidate = function (event) {
            if (event.candidate && callChannel) {
                callChannel.send({ type: "broadcast", event: "ice", payload: { candidate: event.candidate } });
            }
        };

        var offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        callChannel.send({ type: "broadcast", event: "offer", payload: { sdp: offer } });

        state = "in-call";
        setScreen("En communication.");
        startTimer();
    }

    var remoteAudioEl = null;
    function playRemoteAudio(stream) {
        if (!remoteAudioEl) {
            remoteAudioEl = document.createElement("audio");
            remoteAudioEl.autoplay = true;
            document.body.appendChild(remoteAudioEl);
        }
        remoteAudioEl.srcObject = stream;
    }

    function endCallUi(message) {
        teardownCall();
        state = "menu";
        currentNode = "root";
        setScreen(message || "Appel terminé.");
    }

    function teardownCall() {
        stopTimer();
        if (callTimeoutId) { clearTimeout(callTimeoutId); callTimeoutId = null; }
        stopHoldMusic();
        if (pc) {
            try {
                if (callChannel && (state === "in-call" || state === "connecting")) {
                    callChannel.send({ type: "broadcast", event: "hangup", payload: {} });
                }
            } catch (e) {}
            try { pc.close(); } catch (e) {}
            pc = null;
        }
        if (localStream) {
            localStream.getTracks().forEach(function (t) { t.stop(); });
            localStream = null;
        }
        if (callChannel) { sb.removeChannel(callChannel); callChannel = null; }
        if (remoteAudioEl) { remoteAudioEl.srcObject = null; }
        callId = null;
    }

    async function noAnswerFallback() {
        callTimeoutId = null;
        stopHoldMusic();
        if (standardChannel) { sb.removeChannel(standardChannel); standardChannel = null; }
        state = "menu";
        speak("Tous nos conseillers sont en coulisses. Vous pouvez laisser un message.");
        showVoicemailForm();
    }

    async function showVoicemailForm() {
        var box = document.getElementById("amVoicemailBox");
        var { data: { session } } = await sb.auth.getSession();

        if (!session) {
            box.innerHTML =
                '<p class="small-muted" style="font-size:.85rem;color:var(--ink-muted);">' +
                '<a href="page_de_connexion.html">Connectez-vous</a> pour laisser un message.</p>';
            box.style.display = "block";
            return;
        }

        box.innerHTML =
            '<label for="amVoicemailText">Votre message</label>' +
            '<textarea id="amVoicemailText" placeholder="Votre message pour les studios A&amp;M..."></textarea>' +
            '<button type="button" class="btn-primary" id="amVoicemailSend">Envoyer le message</button>' +
            '<p id="amVoicemailStatus" style="font-size:.85rem;color:var(--ink-muted);margin-top:.5rem;"></p>';
        box.style.display = "block";

        document.getElementById("amVoicemailSend").addEventListener("click", async function () {
            var text = document.getElementById("amVoicemailText").value.trim();
            var statusEl = document.getElementById("amVoicemailStatus");
            if (!text) return;

            var { error } = await sb.from("messages").insert({
                user_id: session.user.id,
                creator: "mael",
                sender: "client",
                content: "[Message du standard téléphonique] " + text
            });

            statusEl.textContent = error ? ("Erreur : " + error.message) : "Message envoyé, merci !";
            if (!error) document.getElementById("amVoicemailText").value = "";
        });
    }

    document.addEventListener("DOMContentLoaded", function () {
        injectStyles();
        injectDom();
    });
})();
