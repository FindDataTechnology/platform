# Yizuo Tutorial

> From "I just got an account" to "it finished my first real task." About 10 minutes end to end.
> Looking up one specific thing instead of walking through? Go to [§7 Quick reference](#7-quick-reference).

---

## 0. What this is

Yizuo is an **AI workbench that does the work** — not a chatbot.

The difference: a chatbot answers questions; Yizuo **takes assignments**. Say "review the risk clauses in this contract" and it goes and looks up the relevant law, compares the clauses, grades the risks, and produces a document you can download — without you directing each step.

What it produces is **saved automatically into Outputs**. You never have to remember to save.

**Three things to hold onto** — everything below is an expansion of these:

1. **Pick the right assistant.** A domain-matched assistant answers noticeably better.
2. **Be specific.** Brief it like a colleague: context, examples, and the format you want back.
3. **Ask for sources on anything that matters.** Don't take numbers on faith.

---

## 1. Sign in

**On a computer:** open the Yizuo URL you were given and click **Sign in with SSO**. Sign in with your work email and password.

**On a phone:** find the Yizuo mini program in WeChat → tap **Scan to bind** on the login page → scan the QR code on your computer screen. From then on the phone and the computer are the same workbench, with history and outputs synced.

> On first login you'll bounce to a sign-in page on a different domain (the URL becomes `auth.` something). That's expected — you'll be returned automatically once you're in.

---

## 2. First-run setup: choose your areas of work

After signing in you'll see a panel asking **"What will you use this for?"**

This is the single step worth slowing down for. What you pick decides three things: which domain packs get installed, which assistant is selected by default, and which sections the interface shows.

### What to pick

The panel offers three cards — the three areas that currently ship with a matched pack:

| Card | For | Installs |
|---|---|---|
| **Legal** | Lawyers, legal staff | 法律-合同 (contract review end to end) |
| **Equity research** | Equity researchers | 数据-股票 |
| **Economic analysis** | Economic analysts | 数据-中国经济 |

- **Pick up to three**, or just one. You can change this at any time (see §6).
- There's an optional line underneath where you can note what you actually want to do — "review supplier contracts," for example. It's recorded; it doesn't affect anything else.
- **Don't want to choose now?** Click **Skip for now**. The interface stays untrimmed and nothing is lost — you can come back to it whenever.

### The confirmation list

After you click **Set up my workspace**, you'll see a list of what's about to happen:

```
Install 法律-合同          ← the domain pack
Select your default assistant   ← swap in the matched one
Adjust your workspace layout    ← simplify the interface
```

**Nothing has happened yet — this list is for you to read.** Click **Activate** when you're happy with it.

### After activating

The interface changes immediately: the left navigation narrows to four items (Chat, Library, Outputs, Agents), and the assistant selector at the top switches to the matched one (Contract Reviewer, if you picked Legal).

> If something **could not be installed** — this deployment doesn't carry that pack, say — the done screen **tells you so** rather than claiming everything worked. Nothing else is affected; you can install the missing pack yourself later from **Agents → Industry Packs**.

---

## 3. Chat: start delegating

### Step 1: check the assistant

At the top of the chat page is a selector showing the current assistant. **After first-run setup this is already the matched one**, so you usually don't need to touch it. To change it, open the selector.

- **General assistant** can do anything, but isn't specialised.
- If the assistant you want isn't listed, install it from the **Agents** page.

### Step 2: state the task

Type it like you're briefing a colleague and press Enter.

**You can drag files straight into the input box** — contracts, spreadsheets, meeting notes.

Habits that measurably improve the result:

| Instead of | Say |
|---|---|
| "take a look at this" | "review the risk clauses in this contract and grade them high/medium/low" |
| "write a report" | "write a one-page quarterly brief: conclusion first, then three supporting figures" |
| "analyze the data" | "compare East China sales across the last three months and find the category with the steepest decline" |

**It comes down to three things: context, an example, and the format you want back.**

### Step 3: collect the output

Charts and files it produces **land in Outputs automatically**. You can also save something mid-conversation from its reply.

Not happy? Hit **regenerate**. Want it to stop? Hit **stop**.

> Typing `/` opens the command menu. The ones worth knowing: `/model` (switch model), `/new` (start a new chat), `/clear` (clear the current view), `/help` (open the help center).
> First-time users get a short guided walkthrough. Missed it? **Help (/help) → Getting started → Replay the tour**.

---

## 4. Library: make it remember things

The rule is simple:

- **Something you'll never ask about again** → drag it into the chat.
- **Something you'll come back to repeatedly** (contract templates, product manuals, policy documents) → put it in the Library.

Go to **Library → Add**, or just drag the file into a conversation. PDFs, exported Word text, Markdown, and web links are all supported.

It **indexes uploads automatically**. From then on, when you ask something, it answers **citing those sources** — which is the whole point, and the difference between this and plausible-sounding invention.

---

## 5. Outputs and Automations

### Outputs: everything it has handed over

Every chart and file, newest first. Preview, rename, download, or delete; charts can also **jump back to the conversation** they came from. Use the search box at the top when you can't find something.

### Automations: let it run on a schedule

> **Heads up:** once you've chosen an area of work, the left navigation narrows to four items, and **Automations and Apps are not among them**.
> Nothing is gone — `/tasks` and `/apps` still work when you go there directly. To put them back in the sidebar, ask an admin to adjust the layout.

The **Automations** page turns "things I have to remember" into "things the system remembers."

Click **New** and describe in plain language what to do and how often — "every weekday at 9am, summarise industry news into a one-page brief."

It runs on schedule, saves results into chat and Outputs, and dots the sidebar conversation to let you know. Tasks can be paused, run now, rescheduled, or deleted.

**Good candidates:** weekly report drafts, daily data digests, periodic checks of a page or a metric.

---

## 6. Changing your mind

### Switching areas of work

**Settings → General → Areas of work → Choose areas again.**

The panel reopens with your current selections filled in. Change them and submit.

> **This only ever adds — nothing gets uninstalled.** Packs you already have stay. Experiment freely; there's no penalty for getting it wrong.

### The three tabs on Agents

1. **Assistants** — every available conversational role; pick one to switch at the top of the chat page. The **My assistants** section lets you build your own: describe who it is, how it should answer, and which skills and tools it may use.
2. **Industry Packs** — install a matched bundle in one click. "识律 · 合同审查套件", for instance, adds its assistant to your list. The detail page carries a **usage guide**. Uninstall if it wasn't what you wanted.
3. **Apps** — third-party tool panels your organisation has connected. (Hidden from the sidebar by default; go to `/apps`.)

**How to choose:** if you're unsure, use the general assistant. Once you notice yourself repeating a category of work — reviewing contracts, writing weekly reports, watching a metric — find the matching pack and install it.

---

## 7. Quick reference

| I want to… | Go to |
|---|---|
| Start working | Chat page, type and hit Enter |
| Have it remember a set of documents | Library → Add |
| Find something it produced | Outputs (searchable) |
| Change assistant | Selector at top of chat / Agents page |
| Install a domain pack | Agents → Industry Packs |
| Run something on a schedule | Automations → New (not in the nav? go to `/tasks`) |
| Change my areas of work | Settings → General → Areas of work |
| Change language / theme | Settings → General |
| Bind my phone | Settings → Account (WeChat mini program) |
| See commands and shortcuts | Type `/help` in the chat |

---

## 8. FAQ

**Q: The answers aren't good. What do I do?**
In order: switch to a domain-matched assistant → make the request specific (context, example, format) → send it the relevant files directly.

**Q: Will it make up data?**
Industry Packs are wired to real data sources and cite them, but general conversation can still be wrong. **Ask for sources on anything that matters**, or check the figures in Outputs.

**Q: Can other people see what I upload?**
No. Your chats, library, and outputs live in your own isolated space.

**Q: Will my chat history disappear?**
It's grouped and saved in the sidebar workspace; open any conversation to pick it up. Only deleting removes it.

**Q: Can it produce Word / Excel / PowerPoint?**
Install the 文档工坊 (Document Workshop) pack, then just say "turn this material into a slide deck."

**Q: Can I see my computer's conversations on my phone?**
Yes. The mini program / app and the browser share one account — history and outputs all sync.

**Q: I skipped setup. Can I do it now?**
Settings → General → Areas of work → Choose areas again.

**Q: I want the full navigation back.**
Skipping first-run setup leaves the navigation intact. If you've already chosen an area, ask an admin — layout settings (**Settings → Manage → Layout**) are admin-only.

---

## 9. Three suggestions for your first week

1. **Do exactly one thing this week.** Find a task you repeat weekly and let it try once. If it works, make it an automation.
2. **Don't try to phrase it perfectly the first time.** When it drifts, add context and ask again — the same way you'd coach a new teammate.
3. **Ask for sources.** Where it can give them, make it; where it can't, check yourself. That's the core skill of working with AI.

---

## Next steps

Once you're comfortable with the interface, the next step is letting it finish a deliverable for real — install a pack, produce a conclusion with genuine tool calls, prove it in Trace, and hand over a share link. See lesson one, *Yizuo Getting Started: Your First Deliverable from Zero* (`/research/academy/yizuo-getting-started`).

To deploy your own workflow as a service that programs can call, see lesson two, *Wanxing and Facet Together* (`/research/academy/wanxing-facet-workflow`).

---

*Yizuo · Findata Base — questions to your admin, or feedback in the mini program.*
