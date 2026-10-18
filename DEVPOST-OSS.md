# Devpost — Open Source mini-challenge fields

Draft for the owner to paste. Nothing is submitted from here. Replace the URLs once the repository is public.

| Field | Value |
|---|---|
| Contribution URL | https://github.com/blanco1er/mcp-voice-host |
| Project repository URL | https://github.com/blanco1er/mcp-voice-host |
| GitHub username | blanco1er |

Rule quoted from https://amazonappdev2026.devpost.com/rules (read 18 Oct. 2026): "Create a new, additional open-source project or contribute to an existing public repository during the hackathon window, alongside a primary track submission. […] Required: contribution URL, project repository URL, GitHub username, and a description of what you did, how it works, and why it matters."

## English (to paste)

**What I did.** I built mcp-voice-host, a new MIT-licensed, zero-dependency tool that lets any developer test an MCP server as an Alexa+-style voice add-on, locally and without an account. It grew out of the simulator I wrote for my Alexa+ entry, Mandat, and was rebuilt as a generic host: no Mandat code, any server URL.

**How it works.** A browser page acts as an MCP client (Streamable HTTP, protocol 2025-11-25) and as an MCP Apps host (spec 2026-01-26). You speak (Web Speech API) or type; a transparent keyword matcher picks the tool, fills arguments and asks for missing ones by voice; a "yes" completes a quote-then-confirm flow. Answers are spoken (pluggable TTS, for example Polly) and MCP Apps cards render inside Echo Show 15, Echo Show 8, phone and screenless Echo Dot frames, in a double-iframe sandbox on a separate origin with a CSP built from the resource metadata. A lint panel checks every result against Amazon's public Alexa+ add-on design guide (24 rules, each linked to its source: unspeakable pipes, IDs and URLs, screen references on a Dot, purchases with no confirmation, answers over 30 seconds…). A tiny CLI (`npx github:blanco1er/mcp-voice-host --server <url>`) serves it with a token-guarded local proxy. 46 tests run with `node --test`. It works with the official MCP "everything" server and with my live Alexa+ add-on.

**Why it matters.** Amazon's Web Simulator and Local Inspector require access to the Alexa+ add-ons Private Preview, so most MCP developers cannot see how their server sounds and looks on Alexa devices before they apply. mcp-voice-host closes that loop in the open: voice-first, the voice-only rules of the design guide checked automatically, spec-compliant MCP Apps rendering, and a plug point for any language model. It is a new integration pattern between MCP Apps and voice assistants that other developers can reuse today.

## Français (pour le propriétaire)

**Ce que j'ai fait.** J'ai créé mcp-voice-host, un nouvel outil open source (MIT, sans dépendance) qui permet à n'importe quel développeur de tester un serveur MCP comme un add-on vocal de type Alexa+, en local et sans compte. Il est né du simulateur écrit pour Mandat, mon projet Alexa+, puis a été reconstruit en hôte générique : aucun code de Mandat, n'importe quelle URL de serveur.

**Comment ça marche.** Une page web joue le rôle de client MCP (Streamable HTTP, protocole 2025-11-25) et d'hôte MCP Apps (spec 2026-01-26). On parle (Web Speech API) ou on tape ; un routeur par mots-clés, transparent, choisit l'outil, remplit les arguments et demande à voix haute ceux qui manquent ; un « oui » termine un devis suivi d'une confirmation. Les réponses sont dites (synthèse vocale interchangeable, par exemple Polly) et les cartes MCP Apps s'affichent dans des cadres Echo Show 15, Echo Show 8, téléphone et Echo Dot sans écran, dans un bac à sable à deux iframes sur une origine séparée, avec une CSP tirée des métadonnées. Un panneau de lint vérifie chaque résultat selon le guide de design public des add-ons Alexa+ (24 règles, chacune reliée à sa source). Une petite CLI le sert avec un proxy local protégé par jeton. 46 tests avec `node --test`. Fonctionne avec le serveur officiel MCP « everything » et avec mon add-on Alexa+ en ligne.

**Pourquoi c'est utile.** Le Web Simulator et le Local Inspector d'Amazon demandent l'accès à la Private Preview des add-ons Alexa+ : la plupart des développeurs MCP ne peuvent donc pas voir ni entendre leur serveur sur un appareil Alexa avant de postuler. mcp-voice-host comble ce manque en open source : priorité à la voix, règles « voix seule » du guide vérifiées automatiquement, rendu MCP Apps conforme à la spec, et un point d'entrée pour brancher n'importe quel modèle de langage.
