#!/usr/bin/env node
// settings.js — single source of truth for "what am I actually running?"
//
//   npm run settings        show the effective config, where each value lives,
//                           and any conflicts between the 3 config files.
//
// Rendering lives in settings-report.js so the CLI and the Telegram /settings
// command stay in lock-step. This file just prints the colored version.

import "dotenv/config";
import { buildSettingsReport } from "./settings-report.js";

console.log("\n" + buildSettingsReport({ color: true }) + "\n");
