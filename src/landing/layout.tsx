import type { Child, FC } from "@hono/hono/jsx";

export const Layout: FC<{ title: string; children?: Child }> = (
  { title, children },
) => (
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>{title}</title>
      <script src="https://cdn.tailwindcss.com/3.4.17" />
    </head>
    <body class="min-h-screen bg-[#030303] text-gray-100 antialiased overflow-x-hidden">
      <div class="fixed inset-0 pointer-events-none bg-[radial-gradient(circle_at_top_left,_rgba(34,211,238,0.15),_transparent_28%),radial-gradient(circle_at_top_right,_rgba(168,85,247,0.12),_transparent_24%),radial-gradient(circle_at_bottom,_rgba(14,165,233,0.08),_transparent_34%)]" />
      <div class="fixed inset-0 pointer-events-none bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:72px_72px] opacity-20 [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]" />
      <main class="relative mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        {children}
      </main>
    </body>
  </html>
);
