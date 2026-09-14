import { Link } from 'react-router-dom';

import { AppearanceMenu } from '../components/AppearanceMenu';

/**
 * The privacy policy, and the one page here that must be readable signed out.
 *
 * It exists because the Chrome Web Store will not accept an extension that
 * handles user data without a public policy URL -- but the reason it is *this*
 * page, on the product's own domain, rather than a gist or a Pages file, is
 * that a reviewer following a link to a stranger's hosting learns nothing about
 * whether the policy belongs to the extension. Same origin as the app is the
 * cheapest proof that it does.
 *
 * **Everything below is a claim about code, and was written by reading it.**
 * The provider names, the field lists and the two disclosures that matter --
 * that search queries and captured page text reach OpenAI -- are checked
 * against `services/embedding.js`, `services/enrichment.js`, `oembed.js` and
 * the models. A policy that drifts from the code is worse than none: it is a
 * public, false statement about what happens to someone's data. When any of
 * those files change what leaves this server, this page changes with them.
 */

/** Bumped whenever the substance changes, not when the wording is tidied. */
const LAST_UPDATED = '14 September 2026';

/**
 * Where a reader asks a question or requests deletion.
 *
 * The store requires a working contact, and publishing a personal address is
 * the owner's decision rather than a default -- so this is deliberately a
 * placeholder, and the page says plainly that it is one instead of quietly
 * rendering a dead link.
 */
const CONTACT_EMAIL = '';

function Section({ title, children }) {
  return (
    <section className="mt-10">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-ink-muted">{children}</div>
    </section>
  );
}

/** A list that reads as data rather than prose, for the field inventories. */
function Fields({ children }) {
  return <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-ink-muted">{children}</ul>;
}

export function PrivacyPage() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-3">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            LinkVault
          </Link>
          <AppearanceMenu />
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Privacy policy</h1>
        <p className="mt-2 text-sm text-ink-faint">Last updated {LAST_UPDATED}</p>

        <p className="mt-6 max-w-prose text-sm leading-relaxed text-ink-muted">
          LinkVault is a bookmark manager: you save links, it works out what they are, and you find
          them again later by describing them. This page says what it stores to do that, what leaves
          the server, and what it never does. It covers both the web app and the LinkVault browser
          extension.
        </p>

        <Section title="What the extension collects">
          <p>
            The extension does one thing: when you click its icon and press Save, it reads the page
            you are looking at and sends it to your LinkVault account. Specifically:
          </p>
          <Fields>
            <li>The page&rsquo;s address, title and description.</li>
            <li>Its author, icon and preview image, where the page declares them.</li>
            <li>
              An excerpt of the page&rsquo;s visible text &mdash; about the first 4,000 characters,
              roughly two screens of an article.
            </li>
          </Fields>
          <p>
            Nothing is read until you press Save, and only from the tab you are on. The extension
            asks for <code className="text-xs">activeTab</code> rather than access to all sites,
            which means it has no standing permission to read anything you have not explicitly asked
            it to save. It has no background page, watches no tabs, and collects no browsing
            history.
          </p>
          <p>
            It also stores your access token and the address of your LinkVault server, in the
            browser&rsquo;s local extension storage. Local, never synced &mdash; the token stays on
            the browser you installed it on, rather than propagating to every browser signed into
            your Google account.
          </p>
          <p>
            The extension sends data to your LinkVault server and nowhere else. Its manifest lists
            the only two addresses it is permitted to contact, and the browser blocks the rest. There
            is no analytics, no tracking, and no third-party code in it at all.
          </p>
        </Section>

        <Section title="What the service stores">
          <p>For your account:</p>
          <Fields>
            <li>Your name and email address.</li>
            <li>
              A bcrypt hash of your password. The password itself is never stored and cannot be
              recovered from the hash.
            </li>
            <li>
              For each access token: a name you choose, a SHA-256 hash of the token, and the date it
              was last used. The token itself is shown once and stored only as a hash, so a database
              dump grants nobody access to an account.
            </li>
          </Fields>
          <p>For each bookmark:</p>
          <Fields>
            <li>The URL, and a canonical form of it used to recognise duplicates.</li>
            <li>Title, description, author, domain, icon and preview image.</li>
            <li>A generated summary and generated tags.</li>
            <li>The page excerpt, when one was captured by the extension.</li>
            <li>
              A numeric embedding of the above &mdash; the representation that makes it findable by
              description rather than by exact words.
            </li>
            <li>
              Your own organisation of it: collection, tags, favourite and read state, and when you
              saved it.
            </li>
          </Fields>
          <p>
            The service also keeps a per-day count of how many links each account has processed, to
            enforce its own spending limits, and short-lived request counters used for rate limiting.
            Neither records what you saved or searched for.
          </p>
        </Section>

        <Section title="Who else sees it">
          <p>
            Your bookmarks are private to your account. There is no sharing feature, no public
            collection, and no view in this product through which one user&rsquo;s links, tags,
            searches or summaries are visible to another. Nothing is sold, and nothing is used for
            advertising.
          </p>
          <p>Processing a bookmark does involve three kinds of outside party, and they are:</p>
          <Fields>
            <li>
              <strong className="font-medium text-ink">OpenAI.</strong> Used to write the summary and
              tags, and to produce the embeddings that make search work. It receives a bookmark&rsquo;s
              title, description and domain when generating tags, and its title, summary,
              description, tags, author, domain and captured excerpt when generating an embedding.{' '}
              <strong className="font-medium text-ink">
                It also receives the text of every search you type
              </strong>
              , because a query has to be turned into the same kind of embedding as the bookmarks in
              order to be compared with them. OpenAI&rsquo;s API terms state that data submitted
              through the API is not used to train their models.
            </li>
            <li>
              <strong className="font-medium text-ink">The site you saved.</strong> When the
              extension did not capture the page, the server fetches the URL itself to read its
              title and description &mdash; a request from the server, not from you, carrying no
              cookies or identifying information of yours. For links on YouTube, Vimeo, SoundCloud,
              Spotify, Flickr and Reddit, the server asks that site&rsquo;s public metadata endpoint
              about the URL instead, which means that site learns the URL was looked up.
            </li>
            <li>
              <strong className="font-medium text-ink">Infrastructure providers.</strong> MongoDB
              Atlas stores the data, Render runs the API, and Vercel serves the web app. They hold or
              transmit the data in the course of running the service, under their own terms.
            </li>
          </Fields>
          <p>
            Beyond that, data is disclosed only if the law requires it, and no personal data is sold
            or transferred to third parties for their own purposes.
          </p>
        </Section>

        <Section title="How long it is kept">
          <p>
            Bookmarks are kept until you delete them. Deleting a bookmark removes it, along with its
            summary, tags, captured excerpt and embedding. Revoking an access token takes effect
            immediately &mdash; the next request made with it is refused.
          </p>
          <p>
            Ask to have your account deleted and everything belonging to it is removed: the account,
            every bookmark, every collection and every token.
          </p>
        </Section>

        <Section title="Security">
          <p>
            Passwords are hashed with bcrypt and never stored in the clear. Access tokens are stored
            only as hashes, and a token cannot be used to create another token &mdash; minting one
            requires signing in to the web app, so a token that leaks cannot outlive being revoked.
            Every request for a bookmark is scoped to the account that owns it.
          </p>
          <p>
            Content arriving from a web page &mdash; whether the server fetched it or the extension
            captured it &mdash; is treated as untrusted and sanitised before it is stored. No
            honest description of a system claims it cannot be breached; what is described here is
            what the code does to make one less likely and less damaging.
          </p>
        </Section>

        <Section title="Children">
          <p>LinkVault is not directed at children under 13 and is not intended for their use.</p>
        </Section>

        <Section title="Changes">
          <p>
            If what this page describes changes, the date at the top changes with it. Material
            changes to what leaves the service will be described here rather than quietly amended.
          </p>
        </Section>

        <Section title="Contact">
          {CONTACT_EMAIL ? (
            <p>
              Questions, or a request to delete your account and its data:{' '}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="font-medium text-accent-text underline underline-offset-4"
              >
                {CONTACT_EMAIL}
              </a>
              .
            </p>
          ) : (
            <p>
              A contact address has not been published yet. It is required before this policy is
              submitted to the Chrome Web Store &mdash; set <code className="text-xs">CONTACT_EMAIL</code>{' '}
              in this page&rsquo;s source.
            </p>
          )}
        </Section>

        <p className="mt-12 border-t border-line pt-6 text-sm text-ink-faint">
          <Link to="/" className="underline underline-offset-4">
            Back to LinkVault
          </Link>
        </p>
      </main>
    </div>
  );
}
