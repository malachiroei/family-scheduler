This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Environment Variables

Create a `.env.local` file (you can copy from `.env.example`) and set:

```bash
GEMINI_API_KEY=your_gemini_api_key_here
POSTGRES_URL=your_neon_connection_string

# Web Push (VAPID)
NEXT_PUBLIC_VAPID_PUBLIC_KEY=your_public_vapid_key
VAPID_PRIVATE_KEY=your_private_vapid_key
VAPID_SUBJECT=mailto:you@example.com

# Protect /api/push/remind cron endpoint (recommended)
CRON_SECRET=your_random_secret
```

## PWA + Install

- The app includes `public/manifest.json` and `public/sw.js`.
- Open the app in a supported browser and install it to home screen / desktop using the browser install prompt.
- Push subscription is enabled from the "הפעל התראות" button in the app.

## Push Reminders (15 minutes before)

- New task notifications are sent to all subscribed clients.
- Automatic reminders run for lesson-like tasks (for example English lessons) up to 15 minutes before start time.

## Vercel Cron

The project includes `vercel.json` with a cron job:

- Path: `/api/push/remind`
- Schedule: every minute (`* * * * *`)

If you set `CRON_SECRET`, configure the same value in your Vercel cron call authorization header (`Bearer <CRON_SECRET>`).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
