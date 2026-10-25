# Changelog

All notable changes are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

> Development identity: `v3.2.1-dev.1`. Not a stable release.

### Added
- **Cross-diagram navigation.** Nodes may list sibling `.html` targets via `drilldowns` or a one-entry `href` shorthand. One child uses a native SVG link and visible mark (click follows, Alt-click focuses). Several children keep click-to-focus, with Passport listing every target and Ctrl/double-click opening the first. Child pages can author `meta.parentHref` for header Back; the Viewer also accepts `?from=`.
