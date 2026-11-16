// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file voice-delivery.service.ts
 *
 * Voice as a delivery channel, beside the chat, the notification and messaging — the ONE voice channel: everything said
 * aloud goes through it (scheduled automations, the memory's initiatives, a plugin's `say`, …). A text is said on a
 * voice satellite of the user's account, only where someone is confirmed present now, never into an empty room:
 *   - `areaId`: in that room — the caller knows someone is there (the presence it is answering);
 *   - `person` (a `homeassistant` address, `person.x`): in the room that person is in, not while they are busy;
 *   - neither: the user themselves — their own person (users.haPerson) as above; an account with no person (a household
 *     voice account) in a room with someone in it.
 * Presence is the sensors' (a room tracker, an occupancy sensor) or a satellite turn of the last minutes. The message is
 * written in `chatId` by the caller, and the satellite is bound to that chat, so a spoken reply lands there. Who speaks
 * registers itself (`setChannel`: Home Assistant, home-assistant.service.ts); with none registered, or no presence
 * confirmed, nothing is said (null).
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/** Spoken text is cut here (a satellite is no place for a report: the whole of it stays in the chat). */
export const SPOKEN_MAX_CHARS = 600;

/** Where to say it: a room someone is known to be in, a person, or (neither) the account's own presence. */
export interface VoiceTarget {
  areaId?: string;
  person?: string;
}

/** Who can speak where presence is confirmed (Home Assistant). */
export interface PresenceVoice {
  /**
   * Says `text` on a satellite of `userId`'s account where presence is confirmed: in `where.areaId`, else in the room
   * `where.person` is in (not busy), else in a room with someone in it; binds the satellite to `chatId`. The satellite
   * used, or null.
   */
  sayWherePresent(userId: string, text: string, chatId: string, where: VoiceTarget): Promise<string | null>;
  /** The room (area id) a place name means — a name or an alias of the channel's rooms — or null. */
  placeArea(place: string): string | null;
}

/** Markdown and links out, whitespace folded, cut at a sentence end within SPOKEN_MAX_CHARS: what a voice can read. */
export function speakable(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_`~|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= SPOKEN_MAX_CHARS) return plain;
  const cut = plain.slice(0, SPOKEN_MAX_CHARS);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > SPOKEN_MAX_CHARS / 3 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

@Injectable()
export class VoiceDeliveryService {
  private readonly logger = new Logger(VoiceDeliveryService.name);
  private channel: PresenceVoice | null = null;

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** Registered by whoever speaks (null when it stops). */
  setChannel(channel: PresenceVoice | null): void {
    this.channel = channel;
  }

  /** Whether a voice channel is there at all (a satellite may still find nobody present). */
  available(): boolean {
    return !!this.channel;
  }

  /** The room a place name means for the voice channel, or null (no channel, or no such room). */
  placeArea(place: string): string | null {
    return this.channel?.placeArea(place) ?? null;
  }

  /**
   * Says `text` where presence is confirmed — in `where` (a room, a person), else to the user themselves; the satellite
   * used, or null (nothing said).
   */
  async deliver(userId: string, text: string, chatId: string, where: VoiceTarget = {}): Promise<string | null> {
    const channel = this.channel;
    const spoken = speakable(text);
    if (!channel || !spoken) return null;
    try {
      let target = where;
      if (!where.areaId && !where.person) {
        const [u] = await this.ds.query(`SELECT "haPerson" FROM "users" WHERE "id" = $1`, [userId]) as Array<{ haPerson?: string | null }>;
        if (u?.haPerson) target = { person: u.haPerson };
      }
      return await channel.sayWherePresent(userId, spoken, chatId, target);
    } catch (err) {
      this.logger.warn(`not said by voice: ${(err as Error).message}`);
      return null;
    }
  }
}
