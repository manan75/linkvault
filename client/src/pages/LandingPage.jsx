import { Link } from 'react-router-dom';

import { AppearanceMenu } from '../components/AppearanceMenu';

/*
  What a signed-out visitor sees at `/`.

  The one job is to answer "what is this and why would I use it" before asking
  for an account. Everything here is a claim the code actually makes good on --
  the search example below is the product thesis from `CLAUDE.md`, and the
  honesty section exists because the people reading this page first were invited
  personally and are owed the real state of the thing.
*/

const STEPS = [
  {
    title: 'Save',
    body: 'Paste a URL. It is stored immediately — nothing makes you wait while the page is read.',
  },
  {
    title: 'Forget',
    body: 'In the background LinkVault reads the page, writes a short summary, and picks a few tags.',
  },
  {
    title: 'Describe',
    body: 'Months later, search for what you half-remember instead of the words on the page.',
  },
  {
    title: 'Find',
    body: 'Keyword and meaning are searched together, so both the exact title and the vague memory work.',
  },
];

function Step({ index, title, body }) {
  return (
    <li className="rounded-xl border border-line bg-surface p-5">
      <span className="text-xs font-medium tabular-nums text-accent-text">
        {String(index + 1).padStart(2, '0')}
      </span>
      <h3 className="mt-2 font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-ink-muted">{body}</p>
    </li>
  );
}

export function LandingPage() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <span className="text-lg font-semibold tracking-tight">LinkVault</span>
          <div className="flex items-center gap-2">
            <AppearanceMenu />
            <Link to="/login" className="lv-button-quiet">
              Sign in
            </Link>
            <Link to="/register" className="lv-button">
              Create account
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4">
        <section className="py-16 sm:py-24">
          <p className="text-sm font-medium text-accent-text">Bookmarks you can actually find</p>

          <h1 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight sm:text-5xl">
            &ldquo;I know I saved that link somewhere.&rdquo;
          </h1>

          <p className="mt-5 max-w-xl text-base text-ink-muted sm:text-lg">
            Every bookmark manager can store a link. The hard part is getting it back six months
            later, when you remember what the page was <em>about</em> and nothing else. LinkVault is
            built for that moment.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link to="/register" className="lv-button px-5 py-2.5">
              Create an account
            </Link>
            <Link
              to="/login"
              className="text-sm font-medium text-ink-muted underline underline-offset-4 hover:text-ink"
            >
              I already have one
            </Link>
          </div>
        </section>

        {/*
          The demonstration, rather than an adjective. A query with none of the
          words in the result is the entire difference between this and a folder
          of bookmarks, so it gets shown instead of described.
        */}
        <section className="rounded-2xl border border-line bg-surface-muted p-5 sm:p-8">
          <h2 className="text-sm font-medium text-ink-muted">What searching looks like</h2>

          <div className="mt-4 rounded-xl border border-line bg-surface px-4 py-3 text-sm">
            <span className="text-ink-faint">Search </span>
            <span className="text-ink">that article about making APIs faster using caching</span>
          </div>

          <div className="mt-3 flex items-start gap-3 rounded-xl border border-line bg-surface p-4">
            <div className="mt-0.5 size-8 shrink-0 rounded-md bg-accent-soft" aria-hidden="true" />
            <div className="min-w-0">
              <p className="truncate font-medium">Redis Caching Strategies</p>
              <p className="mt-0.5 truncate text-xs text-ink-faint">redis.io</p>
              <p className="mt-2 text-sm text-ink-muted">
                Patterns for putting a cache in front of a slow data store, and when each one is the
                wrong choice.
              </p>
            </div>
          </div>

          <p className="mt-4 text-sm text-ink-muted">
            The query and the result share no words. It is found by meaning &mdash; and the
            exact-title search you would expect still works, because both run and their results are
            merged.
          </p>
        </section>

        <section className="py-16 sm:py-20">
          <h2 className="text-2xl font-semibold tracking-tight">Save, forget, describe, find</h2>
          <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step, index) => (
              <Step key={step.title} index={index} title={step.title} body={step.body} />
            ))}
          </ul>
        </section>

        <section className="grid gap-4 pb-16 sm:grid-cols-2 sm:pb-20">
          <div className="rounded-xl border border-line bg-surface p-6">
            <h3 className="font-semibold">Every link is read for you</h3>
            <p className="mt-2 text-sm text-ink-muted">
              Title, description, author, favicon and preview image are pulled from the page. A short
              summary and a few tags are generated on top, so a bare URL becomes something you can
              recognise at a glance.
            </p>
          </div>

          <div className="rounded-xl border border-line bg-surface p-6">
            <h3 className="font-semibold">Organised without the filing</h3>
            <p className="mt-2 text-sm text-ink-muted">
              Collections, tags, favourites and read/unread when you want structure. Filters by site
              and by when you saved it for when you only half remember. None of it is required for
              search to work.
            </p>
          </div>

          <div className="rounded-xl border border-line bg-surface p-6">
            <h3 className="font-semibold">Private by default</h3>
            <p className="mt-2 text-sm text-ink-muted">
              Your vault is yours. Nothing is public, nothing is shared, and there is no sharing
              feature to accidentally leave on. The{' '}
              <Link to="/privacy" className="underline underline-offset-4">
                privacy page
              </Link>{' '}
              says plainly what leaves the server and where it goes.
            </p>
          </div>

          <div className="rounded-xl border border-line bg-surface p-6">
            <h3 className="font-semibold">Early, and honest about it</h3>
            <p className="mt-2 text-sm text-ink-muted">
              This is a small project being built in the open, not a company. Expect rough edges,
              expect things to change, and expect the person who made it to read what you send
              through the Feedback button. That is the whole reason you are here.
            </p>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm text-ink-muted">
          <span>LinkVault</span>
          <Link to="/privacy" className="underline underline-offset-4">
            Privacy
          </Link>
        </div>
      </footer>
    </div>
  );
}
