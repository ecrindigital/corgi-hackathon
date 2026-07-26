# Corgi Hackathon — Project Context

Living notes for the team. Update this file as decisions change.

## Decision recap

### Confirmed

- The product generates a personal comic from the user's real digital context and a reference selfie.
- After one-time setup, the ideal experience is one click: **Create my comic → finished comic image**.
- Comic quality is the core work: a story that makes sense, attractive comic art, readable dialogue, a coherent style, and the same recognizable cartoon character across panels.
- The interface should feel playful and cartoon-like, matching the generated comic rather than looking like a corporate AI dashboard.
- The model decides the story, panel count, layout, dialogue, and visual direction. The product does not expose reasoning or add storyboard, layout, or caption-editing systems.
- Merge is the primary sponsor integration. The product should be able to use multiple personal connectors rather than being designed around one provider.
- Offer all useful personal Connectors supported by Merge rather than choosing a three-Connector demo product. The user may authenticate any subset.
- Each third-party Connector requires separate user authentication. Merge centralizes the UI, credential storage, token refresh, and tool access, but it cannot bypass provider consent.
- Use Vercel AI SDK because it simplifies MCP and model integration.
- Deploy on Vercel. The existing VPS is not part of the initial architecture.
- Model choice and character consistency are implementation responsibilities: use whichever available model produces the best comic with the credits/accounts available.
- Define and prove the architecture before assigning the two teammates separate workstreams.

### Architecture direction

- Next.js App Router, TypeScript, Bun, and Tailwind
- One deployable application with one comic-generation endpoint
- Merge Agent Handler + embedded Merge Link
- All useful personal Connectors in onboarding; a curated read-only Tool Pack at generation time
- Generate from any authenticated subset; additional sources improve the result
- Vercel AI SDK, with the final image model selected by a quick output-quality spike
- Vercel deployment
- "Last week" as the initial time period
- No database, queue, worker, or VPS unless the working implementation proves one is necessary

### Relevant decisions still needed

1. Validate the exact Merge Agent Handler authentication and tool flow in code.
2. Run a short image-model comparison and keep the model/prompt that best preserves the reference character, comic style, readable text, and story coherence.
3. Decide the team split after the architecture is proved.

Everything else can wait until the end-to-end comic works.

## Hackathon

- Team: 2 people
- Time available: about 8 hours
- Main theme: build something that **feels personal**, not something that only executes tasks
- Sponsors under consideration:
  - [Merge](https://www.merge.dev/)
  - [Photon](https://photon.codes/)
- Current strategy: make one sponsor integration work well before adding another

### Brief, judging, prizes, and credits

- Theme: **Make It Feel Human**. The brief says to make something that expresses rather than merely executes.
- The deck explicitly suggests pulling someone's real photos, calendar, or messages through Merge and feeding them to an image model to create art that is actually theirs. The comic idea directly matches the brief.
- Judges want to see "soul, not just software."
- The judging group includes YC founders, Corgi, and Merge representatives. Merge judges its sponsor category.
- Overall prizes exceed $1,000. The Merge-specific prize is a PLAUD note taker for each team member.
- Merge Agent Handler includes free usage and connects an agent to 200+ systems.
- Merge Gateway provides $20 of LLM credit: $10 on signup and $10 with the event code `CORGI-CAFE`.
- The team successfully redeemed the deck's $30 Vercel credit with `V0-CORGIMERGE30`.
- Photon provides a one-month messaging number / $25 Photon Pro credit with `hackwithphoton`. It is useful for delivery, not comic image generation.
- The linked GitHub repository is currently empty.

### Event links

- [Hackathon repository](https://github.com/ecrindigital/corgi-hackathon)
- [Hackathon deck](https://www.canva.com/design/DAHQCbsPYvk/83oJpzu0pe4AEACyNSHbZg/view#8)
- [Merge](https://www.merge.dev/)
- [Partiful event](https://partiful.com/e/igxGqp6c00c2ESX44CpG)

## Product idea

Working concept: **click a button and receive a comic about your life**.

The comic could cover the last week, last month, a particular event, or eventually any chosen period. It uses the person's digital context to find memorable, funny, or emotional moments and turns the person into a recurring cartoon character.

Possible uses:

- A funny personal recap
- A keepsake or souvenir from an event
- A shareable weekly or monthly ritual
- A gift made from shared memories

## Current product framing

> Connect the fragmented pieces of your digital life. We turn them into one story—your week as a comic.

Likely first experience:

1. Connect personal data sources.
2. Choose a time period, initially "last week."
3. Upload a selfie for the comic character.
4. Click **Create my comic**.
5. Receive one finished comic image.

The result should feel specifically recognizable to the user, not like a generic summary with their name inserted.

The UI should immediately communicate the product's personality through playful typography, comic-inspired shapes, expressive motion, bright color, and tactile controls. Keep the flow extremely simple and avoid the visual language of enterprise dashboards.

## Merge findings

Merge has two relevant product surfaces:

- **Unified API:** primarily enterprise categories such as HRIS, ATS, accounting, ticketing, CRM, file storage, knowledge base, and chat.
- **Agent Handler:** 123+ MCP-ready connectors across personal and business services. This is the more relevant product for this idea.

Useful Agent Handler connectors:

| Source | What it contributes |
| --- | --- |
| Gmail | Conversations, invitations, travel confirmations, purchases, attachments, and unexpected life events |
| Google Calendar | Timeline, event names, locations, attendees, and descriptions |
| Spotify | Recently played music, top tracks/artists, mood, and a soundtrack |
| Oura / WHOOP | Sleep, workouts, activity, stress, readiness, and comedic contrast |
| Outlook | Email and calendar |
| Google Drive / Dropbox / OneDrive / Box | Personal files and any photos stored there |
| Google Meet / Zoom / Plaud / Fireflies | Conversations and transcripts |
| TikTok / X / YouTube / LinkedIn | Social and media activity, depending on each connector's available tools |
| Google Tasks / Notion / Canva / PayPal | Additional personal signals |

Important limitations and implementation notes:

- No direct Google Photos, Apple Photos, iMessage, or WhatsApp connector has been identified.
- The user must authenticate each Connector separately through Merge Link or Magic Link. This includes separate Gmail, Google Calendar, and Google Drive Connector credentials even when the same Google account is used.
- Merge stores the resulting credential against the user's Merge Registered User and handles subsequent authenticated calls and token refreshes.
- Merge Link can show all configured Connectors in one picker, but selecting one still starts that provider's individual authentication flow.
- Authentication can also happen on demand when an agent first calls an unconnected tool, but that would interrupt the one-click comic experience.
- Gmail, Google Calendar, and Google Drive are separate connectors and require separate configuration/authentication even though Merge handles their connection infrastructure.
- The app must still call each source, handle missing data, and convert different responses into a shared format.
- The experience should work with any subset of connected sources.

Research:

- [Agent Handler connector catalog](https://docs.merge.dev/merge-agent-handler/connectors/overview)
- [Gmail connector](https://docs.merge.dev/merge-agent-handler/connectors/gmail)
- [Google Calendar connector](https://docs.merge.dev/merge-agent-handler/connectors/google-calendar)
- [Spotify connector](https://docs.merge.dev/merge-agent-handler/connectors/spotify)
- [Oura connector](https://docs.merge.dev/merge-agent-handler/connectors/oura)
- [Outlook connector](https://docs.merge.dev/merge-agent-handler/connectors/outlook)
- [Agent Handler application credentials](https://docs.merge.dev/merge-agent-handler/administer/application-credentials)

## Current integration direction

Merge is the primary sponsor integration. Offer all useful personal connectors, let the user authenticate any subset, and give the context agent only the read-only tools relevant to the authenticated sources. "All personal Connectors" means all useful choices are available in onboarding; it does not mean the user must connect all of them or that every available tool is sent to the model.

Recommended connector groups:

| Signal | Connectors |
| --- | --- |
| Plans and events | Google Calendar, Outlook, Calendly |
| Conversations | Gmail, Outlook, Google Meet, Zoom, Plaud, Fireflies |
| Mood and taste | Spotify |
| Body and energy | Oura, WHOOP |
| Thoughts and intentions | Notion, Google Tasks, OneNote, Google Docs |
| Projects and creative work | GitHub, Canva, Figma |
| Files and possible memories | Google Drive, Dropbox, OneDrive, Box |
| Public/social activity | X, TikTok, YouTube, LinkedIn |
| Spending and travel signals | PayPal, TripAdvisor |

Not every connector exposes equally useful personal history. Some are oriented toward business operations, writes, or public content. Only expose a small set of safe read tools from each connector.

Important missing sources include direct iMessage/SMS, WhatsApp, Instagram DMs, Google Photos, Apple Photos/iCloud, Apple Health, and reliable location history.

Potential data flow:

```text
Any authenticated personal connectors
                        |
                        v
               context agent
                        |
                        v
             comic-generation model
                        |
                        v
              finished comic image
```

The model decides the story, panel count, layout, dialogue, and visual direction from the available context. These decisions are internal and are not shown to the user.

## Photon possibility

Photon enables agents to live in messaging surfaces such as iMessage and other communication channels. A possible second phase is to deliver the generated comic through a familiar conversation rather than only displaying it on a website.

Photon is currently optional. It should not delay the core comic-generation loop.

- [Photon overview/update](https://photon.codes/weekly-update/may-14-2026)

## Suggested hackathon scope

Core demo:

- Connect any available personal sources through Merge
- Select "last week"
- Upload one selfie
- Generate one coherent comic image
- Display and download/share the result

Graceful fallback:

- Generate from any successfully connected source
- Clearly show which sources contributed
- Use seeded demo data if live OAuth or an external API fails during judging

Explicitly out of scope unless the core loop is already reliable:

- Entire-life analysis
- Arbitrary date ranges
- Large photo-library ingestion
- Perfect character consistency across many pages
- Comic editing tools
- Social network or marketplace features
- Multiple comic formats

## Main risks

- OAuth or sponsor access consumes too much build time
- Image generation is slow or produces inconsistent characters
- Too much raw context makes story selection generic
- Email contains sensitive information that should not appear unexpectedly
- Live data is boring during the demo
- One failed connector blocks the whole experience
- Generated text inside images is misspelled or unreadable

Possible mitigations:

- Test Merge authentication immediately
- Keep each source optional and fetch sources independently
- Prepare a strong, consented demo account or fixture
- Test comic prompts repeatedly against the same reference person
- Keep a known-good prompt and generated fallback image for the demo

## Minimal architecture

Use one web app and one server-side generation endpoint. Do not introduce queues, databases, microservices, or separate deployment units unless an API forces it.

```text
Browser
  - connect sources
  - upload selfie
  - one Create my comic button
  - display returned image
        |
        v
POST /api/comic
  - load authenticated read tools through AI SDK's MCP client
  - context agent gathers useful events from the requested period
  - image model receives context + selfie + comic prompt
  - endpoint returns the finished image
```

There is no user-visible reasoning, storyboard editor, layout selector, panel-count rule, or caption-composition system. The output contract is simply `generate comic -> image`.

## Team split

Deferred until the minimal architecture is implemented or at least proved with thin spikes. Do not lock the team into frontend/backend or integration/comic roles before knowing which parts actually consume time.

## Recommended tech stack

Build one full-stack TypeScript application:

| Layer | Choice |
| --- | --- |
| App | Next.js 16 App Router + TypeScript |
| Package manager | Bun |
| Styling | Tailwind CSS from the default Next.js setup |
| Backend | Next.js Route Handlers in the same app |
| Merge authentication UI | `@mergeapi/react-agent-handler-link` |
| Merge tools | AI SDK MCP client connected to Agent Handler |
| AI integration | Vercel AI SDK |
| Context model | Best suitable model available through existing accounts or the $20 Merge Gateway credit |
| Image generation | Best reference-image model from a short quality comparison |
| Deployment | Vercel |

Why this stack:

- One language and one deployable application for both teammates
- Next.js Route Handlers keep secrets and Merge calls server-side
- AI SDK handles MCP transport, tool conversion, and model calls
- Vercel provides the shortest Next.js deployment path, HTTPS, environment variables, logs, and previews

Minimal package set:

```text
next react react-dom
ai @ai-sdk/mcp
@mergeapi/react-agent-handler-link
```

Use AI SDK for Merge MCP calls and model access. Give the context agent a curated read-only tool selection from authenticated connectors, then pass its bounded findings and the selfie to the selected image model for one comic-generation call. Add only the provider package required by the winning image model.

### Hosting choice

Vercel is confirmed. This application does not need a persistent machine, GPU, local filesystem, custom networking, or a permanently running worker. Its server code mostly waits on Merge and model API calls.

Resize/compress the selfie in the browser. Prefer returning a model-hosted image URL or a compact image response; introduce Blob storage only if the working model/API requires it.

### Hackathon shortcuts

- No application login: create one anonymous Merge Registered User and keep its ID in an HTTP-only cookie.
- No database: Merge stores connector credentials; keep the current comic in browser memory.
- No object storage: return the generated image as a data URL and let the browser download it.
- No job queue: run one generation request with a visible progress state.
- One Tool Pack containing a small read-only tool subset from each useful personal connector.
- Let the image model decide the comic's story, panel count, layout, and dialogue.
- Return the model's finished comic image without reconstructing it in the app.
- Keep one context fixture and known-good comic for development and demo fallback.

Add persistence, background jobs, object storage, and full user accounts only after the core demo works.

## Deferred until the core works

- Final name and broader visual identity
- Photon delivery
- Arbitrary or entire-life date ranges
- More than one comic format
- Editing and regeneration controls
- Accounts, persistent storage, history, and social features
