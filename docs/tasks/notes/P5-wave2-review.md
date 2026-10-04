# Phase 5, batch 2 (wave 2: P5-04) — review

Branch `p5-wave2-a11y` against `phase-5`, 2026-10-04. One agent audited 24 panel surfaces against six criteria (keyboard reach, operation, visible focus, ARIA, focus restore, reduced motion): 33 gaps grouped into 19 findings, all fixed — a skip link and named landmarks, arrow keys in the navigation (a light tree pattern) and in the card and history lists, focus into and back from popovers, confirmations (starting on "Keep"), edit forms and the inspector, focus to the page title on route changes and to the next item when one goes away, a polite "N waiting" announcement (never on load), a global reduced-motion rule for the panel, a light-theme contrast fix; axe-core checks over 16 panel views and the scene's overlays with no findings. Decision 81 recorded.

An independent review found no blocker. Fixed, each with a test: the wide bar's connection text was a live region announcing every reconnect; leaving a replay started from the history page lost the focus; an answered question in the main area sent the focus to the title instead of the next question; list arrows could strand an open menu or a pending confirmation; two axe checks did not wait for their view; two labels existed only to satisfy a rule. SPEC 81 reworded: disclosures (More, ⋯) keep the focus on their button.

Deferred (P5-04 notes): an optional "?" shortcuts help, a colour-contrast run in a real browser, a VoiceOver pass, chatty chat and transcript logs, the landmark announced as "navigation navigation".

Gates on the merged branch: build, typecheck, lint, format:check green; protocol 70, server 949 (+1 skipped), web 1135.
