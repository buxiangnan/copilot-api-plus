#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"

import { ensurePaths, PATHS } from "./lib/paths"
import { clearGithubToken } from "./lib/token"
import {
  clearAntigravityAuth,
  getAntigravityAuthPath,
} from "./services/antigravity/auth"
import { clearZenAuth, getZenAuthPath } from "./services/zen/auth"

export async function runLogout(options: {
  github?: boolean
  zen?: boolean
  antigravity?: boolean
  all?: boolean
}): Promise<void> {
  await ensurePaths()

  if (options.all) {
    // Clear all credentials
    await clearGithubToken()
    await clearZenAuth()
    await clearAntigravityAuth()
    consola.success("Logged out from all services")
    consola.info(`GitHub token: ${PATHS.GITHUB_TOKEN_PATH}`)
    consola.info(`Zen API key: ${getZenAuthPath()}`)
    consola.info(`Antigravity accounts: ${getAntigravityAuthPath()}`)
    return
  }

  if (options.github) {
    // Clear only GitHub token
    await clearGithubToken()
    consola.success("Logged out from GitHub Copilot")
    consola.info(`Token file location: ${PATHS.GITHUB_TOKEN_PATH}`)
    return
  }

  if (options.zen) {
    // Clear only Zen API key
    await clearZenAuth()
    consola.success("Logged out from OpenCode Zen")
    consola.info(`Zen API key location: ${getZenAuthPath()}`)
    return
  }

  if (options.antigravity) {
    // Clear only Antigravity accounts
    await clearAntigravityAuth()
    consola.success("Logged out from Google Antigravity")
    consola.info(`Antigravity accounts location: ${getAntigravityAuthPath()}`)
    return
  }

  // Default: show interactive prompt
  const choice = await consola.prompt(
    "Which credentials do you want to clear?",
    {
      type: "select",
      options: [
        "GitHub Copilot token",
        "OpenCode Zen API key",
        "Google Antigravity accounts",
        "All credentials",
      ],
    },
  )

  switch (choice) {
    case "GitHub Copilot token": {
      await clearGithubToken()
      consola.success("Logged out from GitHub Copilot")
      consola.info(`Token file location: ${PATHS.GITHUB_TOKEN_PATH}`)

      break
    }
    case "OpenCode Zen API key": {
      await clearZenAuth()
      consola.success("Logged out from OpenCode Zen")
      consola.info(`Zen API key location: ${getZenAuthPath()}`)

      break
    }
    case "Google Antigravity accounts": {
      await clearAntigravityAuth()
      consola.success("Logged out from Google Antigravity")
      consola.info(`Antigravity accounts location: ${getAntigravityAuthPath()}`)

      break
    }
    case "All credentials": {
      await clearGithubToken()
      await clearZenAuth()
      await clearAntigravityAuth()
      consola.success("Logged out from all services")

      break
    }
    // No default
  }
}

export const logout = defineCommand({
  meta: {
    name: "logout",
    description: "Clear stored credentials and logout",
  },
  args: {
    github: {
      alias: "g",
      type: "boolean",
      default: false,
      description: "Clear only GitHub Copilot token",
    },
    zen: {
      alias: "z",
      type: "boolean",
      default: false,
      description: "Clear only OpenCode Zen API key",
    },
    antigravity: {
      type: "boolean",
      default: false,
      description: "Clear only Google Antigravity accounts",
    },
    all: {
      alias: "a",
      type: "boolean",
      default: false,
      description: "Clear all credentials (GitHub, Zen, and Antigravity)",
    },
  },
  run({ args }) {
    return runLogout({
      github: args.github,
      zen: args.zen,
      antigravity: args.antigravity,
      all: args.all,
    })
  },
})
