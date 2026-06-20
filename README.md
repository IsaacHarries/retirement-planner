# Retirement Planner

A small desktop app that projects when your retirement savings can fund your
inflation-adjusted spending — the **crossover** point — under an average and a
below-average market. Built with React + Recharts inside a [Tauri](https://tauri.app) shell.

> Estimate only. This is a personal planning tool, **not financial advice**.
> It assumes steady annual returns (real markets are bumpy), withdrawals before
> taxes, and no employer match. Social Security is optional and off by default.

## What it does

- Projects portfolio growth from your current balance and annual contributions.
- Plots a rising "target" line = inflation-adjusted spending ÷ safe withdrawal rate.
- Marks the earliest age each scenario crosses the target, and the monthly income
  you could draw then (in future and today's dollars).
- A **Stop maxing out at age** lever lets you model stopping contributions early
  (e.g. a forced career change).
- All inputs are saved automatically (in the app's local storage) and reload next launch.

## Prerequisites

- [Node.js](https://nodejs.org) 18+ and npm
- [Rust](https://www.rust-lang.org/tools/install) (stable) + Cargo
- Platform webview dependencies — see Tauri's prerequisites guide:
  https://v2.tauri.app/start/prerequisites/
  (Windows: WebView2; macOS: Xcode CLT; Linux: `webkit2gtk`, `librsvg`, etc.)

## Run in development

```bash
npm install
npm run app        # = tauri dev — opens the desktop window with hot reload
```

To run just the web frontend in a browser instead: `npm run dev` then open http://localhost:1420.

## Build a distributable app

```bash
npm run app:build  # = tauri build — produces installers in src-tauri/target/release/bundle/
```

If you change the icon, replace `src-tauri/icons/icon.png` and regenerate the set:

```bash
npm run tauri icon src-tauri/icons/icon.png
```

## Project layout

```
src/                 React frontend
  App.jsx            the calculator (model + UI)
  main.jsx           React entry point
src-tauri/           Rust/Tauri shell
  tauri.conf.json    window + bundle config
  src/lib.rs         app entry
  icons/             app icons
```

## Where your data lives

Inputs persist in the WebView's local storage under the key
`retirement-crossover-settings`. The **Reset** button clears it.

## License

Personal project — do as you like with it.
