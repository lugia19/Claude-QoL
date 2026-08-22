# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- Initialized `CHANGELOG.md` using the Keep a Changelog v2.0 format.
- Created `structure.yaml` to document and track the project's layout and components.
- Added a human-readable ASCII tree representation to `structure.yaml` for easier visualization of the codebase.

### Changed
- Replaced the default summarization prompt in `content/main/forking.js` with a new, highly-structured prompt designed to optimize context transfer and fidelity for continuation in a new window.
- Updated default settings in the forking UI based on best practices: changed the verbatim slider default from 20% to 30%, and enabled "Forward files from summarized section" by default.
- Implemented a global Error Toast notification system (`bottom-right`) to catch and display critical background errors (e.g. TTS failures, Export crashes) that were previously silently logged to the console.
- Refactored hardcoded Javascript hex colors into `var(--qol-primary)` CSS custom properties, greatly improving compatibility with styling extensions like DarkReader.
- Hardened the summarization architecture against Prompt Injection attacks by sealing systemic instructions in XML `<instructions>` tags, instructing the model to prioritize System Rules over user inputs, and aggressively sanitizing input slider boundaries to prevent API crashes.
- Implemented a pre-processing string sanitization pipeline that automatically strips XML instruction tags from chatlogs and chunk summaries before transmission to definitively close all injection vectors.
- Replaced the simple verbatim slider with a hybrid component: the visual slider is now bounded to the 20-50% sweet spot with 2% increments, and paired with a synchronized numeric input to allow adjustments outside that band.
