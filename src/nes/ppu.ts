// PPU: Picutre Processing Unit

import {Const, kColors, kStaggered, kFlipBits} from './const.ts'
import {Util} from './util.ts'

const REGISTER_COUNT = 8
const VRAM_SIZE = 0x4000
const OAM_SIZE = 0x0100

// PPUCTRL ($2000)
const PPUCTRL = 0x00
const VINT_ENABLE = 0x80  // V: 1=Trigger NMI when VBLANK start
const SPRITE_SIZE = 0x20
const BG_PATTERN_TABLE_ADDRESS = 0x10
const SPRITE_PATTERN_TABLE_ADDRESS = 0x08
const INCREMENT_MODE = 0x04  // I: 1=+32, 0=+1
const BASE_NAMETABLE_ADDRESS = 0x03

// PPUMASK ($2001)
const PPUMASK = 0x01
const SHOW_SPRITE = 0x10
const SHOW_BG = 0x08
const SHOW_SPRITE_LEFT_8PX = 0x04
const SHOW_BG_LEFT_8PX = 0x02

// PPUSTATUS ($2002)
const PPUSTATUS = 0x02
const VBLANK = 0x80
const SPRITE0HIT = 0x40
const SPRITE_OVERFLOW = 0x20

// OAMADDR ($2003)
const OAMADDR = 0x03

// OAMDATA ($2004)
const OAMDATA = 0x04

const PPUSCROLL = 0x05  // $2005
const PPUADDR = 0x06  // $2006
const PPUDATA = 0x07  // $2007

// Sprite
const FLIP_HORZ = 0x40
const FLIP_VERT = 0x80

export enum MirrorMode {
  HORZ = 0,
  VERT = 1,
  SINGLE0 = 2,
  SINGLE1 = 3,
}

interface HEvents {
  count: number
  events: any[]
}

const kMirrorModeBitTable = [0x50, 0x44, 0x00, 0x55]

const kInitialPalette = [
  0x09, 0x01, 0x00, 0x01, 0x00, 0x02, 0x02, 0x0d, 0x08, 0x10, 0x08, 0x24, 0x00, 0x00, 0x04, 0x2c,
  0x09, 0x01, 0x34, 0x03, 0x00, 0x04, 0x00, 0x14, 0x08, 0x3a, 0x00, 0x02, 0x00, 0x20, 0x2c, 0x08,
]

function cloneArray(array) {
  return array.concat()
}

function getNameTable(baseNameTable: number, bx: number, by: number,
                      mirrorModeBit: number): number
{
  const page = (((bx >> 5) & 1) + (((by / 30) & 1) << 1)) ^ baseNameTable  // 0~3
  const m = (mirrorModeBit << (10 - (page << 1))) & 0x0c00
  return 0x2000 + m
}

function getPpuAddr(adr: number, mirrorModeBit: number): number {
  if (0x3000 <= adr && adr < 0x3f00)
    adr -= 0x1000  // Map 0x3000~3eff to 0x2000~
  if (0x2000 <= adr && adr < 0x3000) {
    const page = (adr >> 10) & 3
    const m = (mirrorModeBit << (10 - (page << 1))) & 0x0c00
    return (adr & 0xf3ff) | m
  }

  if (0x3f00 <= adr && adr <= 0x3fff) {
    adr &= 0xff1f  // Repeat 0x3f00~0x3f1f --> 0x3fff
    // "Addresses $3F10/$3F14/$3F18/$3F1C are mirrors of $3F00/$3F04/$3F08/$3F0C."
    // http://wiki.nesdev.com/w/index.php/PPU_palettes#Memory_Map
    if ((adr & 0xfff3) === 0x3f10)
      adr &= 0xffef
  }
  return adr
}

function incPpuAddr(ppuAddr: number, ppuCtrl: number): number {
  const add = ((ppuCtrl & INCREMENT_MODE) !== 0) ? 32 : 1
  return (ppuAddr + add) & (VRAM_SIZE - 1)
}

export class Ppu {
  public regs: Uint8Array
  public chrData: Uint8Array
  public vram: Uint8Array
  public oam: Uint8Array  // Object Attribute Memory
  public hcount: number
  public scrollX: number
  public scrollY: number
  public mirrorModeBit: number  // 2bit x 4page
  private latch: number
  private ppuAddr: number
  private bufferedValue: number
  private chrBankOffset: number[]
  private hevents: HEvents
  private hevents2: HEvents

  constructor() {
    this.regs = new Uint8Array(REGISTER_COUNT)
    this.vram = new Uint8Array(VRAM_SIZE)
    this.oam = new Uint8Array(OAM_SIZE)
    this.mirrorModeBit = 0x44
    this.hevents = {count: 0, events: []}
    this.hevents2 = {count: 0, events: []}

    this.chrBankOffset = new Array(8)
    for (let i = 0; i < 8; ++i)
      this.chrBankOffset[i] = i << 10
  }

  public reset(): void {
    this.regs.fill(0)
    this.vram.fill(0)
    this.oam.fill(0)
    this.hcount = 0
    this.scrollX = this.scrollY = 0
    this.ppuAddr = 0
    this.latch = 0
    this.bufferedValue = 0
    this.hevents = {count: 0, events: []}
    this.hevents2 = {count: 0, events: []}

    for (let i = 0; i < 8; ++i)
      this.chrBankOffset[i] = i << 10

    for (let i = 0; i < 16 * 2; ++i)
      this.vram[0x3f00 + i] = kInitialPalette[i]
  }

  public setChrData(chrData: Uint8Array): void {
    if (chrData && chrData.length > 0)
      this.chrData = chrData
    else  // CHR RAM
      this.chrData = this.vram
  }

  public setChrBank(value: number): void {
    const base = value << 3
    for (let i = 0; i < 8; ++i)
      this.setChrBankOffset(i, base + i)
  }

  public setChrBankOffset(bank: number, value: number): void {
    const max = this.chrData.length
    this.chrBankOffset[bank] = (value << 10) & (max - 1)  // 0x0400

    this.addHevent({scrollX: this.scrollX, scrollY: this.scrollY, ppuCtrl: this.regs[PPUCTRL],
                    ppuMask: this.regs[PPUMASK], chrBankOffset: cloneArray(this.chrBankOffset),
                    mirrorModeBit: this.mirrorModeBit})
  }

  public setMirrorMode(mode: MirrorMode): void {
    this.mirrorModeBit = kMirrorModeBitTable[mode]

    this.addHevent({scrollX: this.scrollX, scrollY: this.scrollY, ppuCtrl: this.regs[PPUCTRL],
                    ppuMask: this.regs[PPUMASK], chrBankOffset: cloneArray(this.chrBankOffset),
                    mirrorModeBit: this.mirrorModeBit})
  }

  public read(reg: number): number {
    let result = this.regs[reg]
    switch (reg) {
    case PPUSTATUS:
      this.regs[PPUSTATUS] &= ~VBLANK
      this.latch = 0
      break
    case OAMDATA:
      result = this.oam[this.regs[OAMADDR]]
      break
    case PPUDATA:
      {
        const ppuAddr = this.ppuAddr
        const addr = getPpuAddr(ppuAddr, this.mirrorModeBit)
        if (0x3f00 <= addr && addr <= 0x3fff) {  // Palette
          result = this.readPpuDirect(addr)  // Palette read shouldn't be buffered like other VRAM
          // Palette read should also read VRAM into read buffer
          this.bufferedValue = this.readPpuDirect(getPpuAddr(ppuAddr - 0x1000, this.mirrorModeBit))
        } else {
          result = this.bufferedValue
          this.bufferedValue = this.readPpuDirect(addr)
        }
        this.ppuAddr = incPpuAddr(ppuAddr, this.regs[PPUCTRL])
      }
      break
    default:
      break
    }
    return result
  }

  public write(reg: number, value: number): void {
    if (reg === PPUSTATUS) {
      value &= ~(VBLANK | SPRITE0HIT | SPRITE_OVERFLOW)
    }

    this.regs[reg] = value

    switch (reg) {
    case PPUCTRL:
    case PPUMASK:
      this.addHevent({scrollX: this.scrollX, scrollY: this.scrollY, ppuCtrl: this.regs[PPUCTRL],
                      ppuMask: this.regs[PPUMASK], chrBankOffset: cloneArray(this.chrBankOffset),
                      mirrorModeBit: this.mirrorModeBit})
      break
    case OAMDATA:
      {
        const oamAddr = this.regs[OAMADDR]
        this.oam[oamAddr] = value
        this.regs[OAMADDR] = (oamAddr + 1) & 0xff
      }
      break
    case PPUSCROLL:
      if (this.latch === 0) {
        this.scrollX = value
      } else {
        //this.scrollY = value
        if (this.hcount >= 240)
          this.scrollY = value
        this.addHevent({scrollX: this.scrollX, scrollY: this.scrollY, ppuCtrl: this.regs[PPUCTRL],
                        ppuMask: this.regs[PPUMASK], chrBankOffset: cloneArray(this.chrBankOffset),
                        mirrorModeBit: this.mirrorModeBit})
      }
      this.latch = 1 - this.latch
      break
    case PPUADDR:
      if (this.latch === 0)
        this.ppuAddr = value
      else
        this.ppuAddr = ((this.ppuAddr << 8) | value) & (VRAM_SIZE - 1)
      this.latch = 1 - this.latch
      break
    case PPUDATA:
      {
        const addr = getPpuAddr(this.ppuAddr, this.mirrorModeBit)
        this.vram[addr] = value
        this.ppuAddr = incPpuAddr(this.ppuAddr, this.regs[PPUCTRL])
      }
      break
    default:
      break
    }
  }

  public copyWithDma(array: Uint8Array, start: number): void {
    const dst = this.oam
    let j = this.regs[OAMADDR]
    for (let i = 0; i < 256; ++i) {
      dst[j] = array[start + i]
      j = (j + 1) & 255
    }
    // TODO: Block CPU.
  }

  public setVBlank(): void {
    this.regs[PPUSTATUS] = this.regs[PPUSTATUS] | VBLANK

    // Swap HEvents
    const tmp = this.hevents
    this.hevents = this.hevents2
    this.hevents2 = tmp
    this.hevents.count = 0

    this.addHevent({scrollX: this.scrollX, scrollY: this.scrollY, ppuCtrl: this.regs[PPUCTRL],
                    ppuMask: this.regs[PPUMASK], chrBankOffset: cloneArray(this.chrBankOffset),
                    mirrorModeBit: this.mirrorModeBit})
  }
  public clearVBlank(): void {
    this.regs[PPUSTATUS] &= ~(VBLANK | SPRITE0HIT)
  }

  public interruptEnable(): boolean {
    return (this.regs[PPUCTRL] & VINT_ENABLE) !== 0
  }

  public getBgPatternTableAddress(): number {
    return ((this.regs[PPUCTRL] & BG_PATTERN_TABLE_ADDRESS) << 8)
  }

  public getSpritePatternTableAddress(): number {
    if ((this.regs[PPUCTRL] & SPRITE_SIZE) === 0)
      return ((this.regs[PPUCTRL] & SPRITE_PATTERN_TABLE_ADDRESS) << 9)
    return 0
  }

  public isSprite8x16(): boolean {
    return (this.regs[PPUCTRL] & SPRITE_SIZE) !== 0
  }

  public renderBg(pixels: Uint8ClampedArray): void {
    const n = this.hevents.count
    for (let i = 0; i < n; ++i) {
      const h = this.hevents.events[i]
      const hline0 = h.hcount
      const hline1 = i < n - 1 ? this.hevents.events[i + 1].hcount : 240 + 8
      if (hline0 >= hline1)
        continue
      if ((h.ppuMask & SHOW_BG) === 0) {
        this.clearBg(pixels, hline0, hline1, Const.WIDTH, Const.WIDTH)
        continue
      }
      const baseNameTable = h.ppuCtrl & BASE_NAMETABLE_ADDRESS
      const chrStart = (h.ppuCtrl & BG_PATTERN_TABLE_ADDRESS) << 8
      let x0 = 0
      if ((h.ppuMask & SHOW_BG_LEFT_8PX) === 0)
        this.clearBg(pixels, hline0, hline1, x0 = 8, Const.WIDTH)
      this.doRenderBg2(pixels, h.scrollX, h.scrollY, baseNameTable, hline0, hline1, x0,
                       h.chrBankOffset, h.mirrorModeBit, chrStart)
    }
  }

  public doRenderBg(pixels: Uint8ClampedArray, lineWidth: number, scrollX: number, scrollY: number,
                    startX: number, startY: number, nameTableOffset: number): void
  {
    const getBgPat = (chridx, py) => {
      const idx = chridx + py

      const bank = (idx >> 10) & 7
      const bankOfs = this.chrBankOffset[bank]
      const ofs = idx & 0x03ff
      const p = bankOfs + ofs

      return (kStaggered[this.chrData[p + 8]] << 1) | kStaggered[this.chrData[p]]
    }

    const W = 8
    const chrStart = this.getBgPatternTableAddress()
    const vram = this.vram
    const paletTable = 0x3f00

    const clearColor = vram[paletTable] & 0x3f  // Universal background color
    const clearR = kColors[clearColor * 3 + 0]
    const clearG = kColors[clearColor * 3 + 1]
    const clearB = kColors[clearColor * 3 + 2]

    if (scrollY >= 240)
      scrollY = (scrollY - 256)

    for (let bby = 0; bby < Const.HEIGHT / W + 1; ++bby) {
      const by = ((bby + (scrollY >> 3)) + 60) % 60
      const ay = by % 30
      for (let bbx = 0; bbx < Const.WIDTH / W + 1; ++bbx) {
        const bx = (bbx + (scrollX >> 3)) & 63
        const ax = bx & 31

        const nameTable = getNameTable(0, bx, by, this.mirrorModeBit) + nameTableOffset
        const name = vram[nameTable + ax + (ay << 5)]
        const chridx = name * 16 + chrStart
        const palShift = (ax & 2) + ((ay & 2) << 1)
        const atrBlk = (ax >> 2) + ((ay << 1) & 0x0f8)
        const attributeTable = nameTable + 0x3c0
        const paletHigh = ((vram[attributeTable + atrBlk] >> palShift) & 3) << 2

        for (let py = 0; py < W; ++py) {
          const yy = bby * W + py - (scrollY & 7)
          if (yy < 0)
            continue
          if (yy >= Const.HEIGHT)
            break
          const pat = getBgPat(chridx, py)
          for (let px = 0; px < W; ++px) {
            const xx = bbx * W + px - (scrollX & 7)
            if (xx < 0)
              continue
            if (xx >= Const.WIDTH)
              break
            const pal = (pat >> ((W - 1 - px) << 1)) & 3
            let r = clearR, g = clearG, b = clearB
            if (pal !== 0) {
              const palet = paletHigh + pal
              const col = vram[paletTable + palet] & 0x3f
              const c = col * 3
              r = kColors[c]
              g = kColors[c + 1]
              b = kColors[c + 2]
            }

            const index = ((yy + startY) * lineWidth + (xx + startX)) * 4
            pixels[index + 0] = r
            pixels[index + 1] = g
            pixels[index + 2] = b
          }
        }
      }
    }
  }

  public doRenderBg2(pixels: Uint8ClampedArray, scrollX: number, scrollY: number, baseNameTable: number,
                     hline0: number, hline1: number, x0: number, chrBankOffset: number,
                     mirrorModeBit: number, chrStart: number): void
  {
    const getBgPat = (chridx, py) => {
      const idx = chridx + py

      const bank = (idx >> 10) & 7
      const bankOfs = chrBankOffset[bank]
      const ofs = idx & 0x03ff
      const p = bankOfs + ofs

      return (kStaggered[this.chrData[p + 8]] << 1) | kStaggered[this.chrData[p]]
    }

    const W = 8
    const LINE_WIDTH = Const.WIDTH
    const vram = this.vram
    const paletTable = 0x3f00

    const clearColor = vram[paletTable] & 0x3f  // Universal background color
    const clearR = kColors[clearColor * 3 + 0]
    const clearG = kColors[clearColor * 3 + 1]
    const clearB = kColors[clearColor * 3 + 2]

    if (scrollY >= 240)
      scrollY = (scrollY - 256)

    const bby0 = (hline0 / 8) | 0 , bby1 = ((hline1 + 7) / 8) | 0
    let py0 = 0  // hline0 & 7
    for (let bby = bby0; bby < bby1; ++bby) {
      const by = ((bby + (scrollY >> 3)) + 60) % 60
      const ay = by % 30
      for (let bbx = 0; bbx < Const.WIDTH / W + 1; ++bbx) {
        const bx = (bbx + (scrollX >> 3)) & 63
        const ax = bx & 31

        const nameTable = getNameTable(baseNameTable, bx, by, mirrorModeBit)
        const name = vram[nameTable + ax + (ay << 5)]
        const chridx = name * 16 + chrStart
        const palShift = (ax & 2) + ((ay & 2) << 1)
        const atrBlk = (ax >> 2) + ((ay << 1) & 0x0f8)
        const attributeTable = nameTable + 0x3c0
        const paletHigh = ((vram[attributeTable + atrBlk] >> palShift) & 3) << 2

        for (let py = py0; py < W; ++py) {
          const yy = bby * W + py - (scrollY & 7)
          if (yy < 0)
            continue
          if (yy >= Const.HEIGHT)
            break
          const pat = getBgPat(chridx, py)
          for (let px = 0; px < W; ++px) {
            const xx = bbx * W + px - (scrollX & 7)
            if (xx < x0)
              continue
            if (xx >= Const.WIDTH)
              break
            const pal = (pat >> ((W - 1 - px) << 1)) & 3
            let r = clearR, g = clearG, b = clearB
            if (pal !== 0) {
              const palet = paletHigh + pal
              const col = vram[paletTable + palet] & 0x3f
              const c = col * 3
              r = kColors[c]
              g = kColors[c + 1]
              b = kColors[c + 2]
            }

            const index = (yy * LINE_WIDTH + xx) * 4
            pixels[index + 0] = r
            pixels[index + 1] = g
            pixels[index + 2] = b
          }
        }
        py0 = 0
      }
    }
  }

  public clearBg(pixels: Uint8ClampedArray, hline0: number, hline1: number, x: number, lineWidth: number): void {
    const LINE_BYTES = lineWidth * 4
    const paletTable = 0x3f00
    const clearColor = this.vram[paletTable] & 0x3f  // Universal background color
    const clearR = kColors[clearColor * 3 + 0]
    const clearG = kColors[clearColor * 3 + 1]
    const clearB = kColors[clearColor * 3 + 2]
    for (let i = hline0; i < hline1; ++i) {
      let index = i * LINE_BYTES
      for (let j = 0; j < x; ++j) {
        pixels[index++] = clearR
        pixels[index++] = clearG
        pixels[index++] = clearB
        pixels[index++] = 255
      }
    }
  }

  public setHcount(hcount: number) {
    this.hcount = hcount
    this.checkSprite0Hit(hcount)
  }

  public renderSprite(pixels: Uint8ClampedArray): void {
    let chrStart = 0
    const n = this.hevents.count
    for (let i = 0; i < n; ++i) {
      const h = this.hevents.events[i]
      if ((h.ppuMask & SHOW_SPRITE) === 0)
        continue
      const hline0 = h.hcount
      const hline1 = i < n - 1 ? this.hevents.events[i + 1].hcount : 240 + 8
      if (hline0 >= hline1)
        continue
      if ((this.regs[PPUCTRL] & SPRITE_SIZE) === 0)
        chrStart = ((this.regs[PPUCTRL] & SPRITE_PATTERN_TABLE_ADDRESS) << 9)
      const x0 = (h.ppuMask & SHOW_SPRITE_LEFT_8PX) ? 0 : 8
      this.renderSprite2(pixels, hline0, hline1, x0, h.chrBankOffset, chrStart)
    }
  }

  public renderSprite2(pixels: Uint8ClampedArray, hline0: number, hline1: number, x0: number,
                       chrBankOffset: number, chrStart: number): void
  {
    const getSpritePat = (chridx, ppy, flipHorz) => {
      const idx = chridx + (ppy & 7) + ((ppy & 8) << 1)

      const bank = (idx >> 10) & 7
      const bankOfs = chrBankOffset[bank]
      const ofs = idx & 0x03ff
      const p = bankOfs + ofs

      let patHi = this.chrData[p + 8]
      let patLo = this.chrData[p]
      if (flipHorz) {
        patHi = kFlipBits[patHi]
        patLo = kFlipBits[patLo]
      }

      return (kStaggered[patHi] << 1) | kStaggered[patLo]
    }

    const W = 8
    const LINE_WIDTH = Const.WIDTH
    const PALET = 0x03

    const oam = this.oam
    const vram = this.vram
    const paletTable = 0x3f10
    const isSprite8x16 = this.isSprite8x16()
    const h = isSprite8x16 ? 16 : 8

    for (let i = 64; --i >= 0; ) {
      const y = oam[i * 4] + 1
      if (y < hline0 || y >= hline1)
        continue

      const index = oam[i * 4 + 1]
      const attr = oam[i * 4 + 2]
      const flipVert = (attr & FLIP_VERT) !== 0
      const flipHorz = (attr & FLIP_HORZ) !== 0
      const x = oam[i * 4 + 3]

      const chridx = (isSprite8x16
                      ? (index & 0xfe) * 16 + ((index & 1) << 12)
                      : index * 16 + chrStart)
      const paletHigh = (attr & PALET) << 2

      for (let py = 0; py < h; ++py) {
        if (y + py >= Const.HEIGHT)
          break

        const ppy = flipVert ? (h - 1) - py : py
        const pat = getSpritePat(chridx, ppy, flipHorz)
        for (let px = 0; px < W; ++px) {
          const xx = x + px
          if (xx < x0)
            continue
          if (xx >= Const.WIDTH)
            break

          const pal = (pat >> ((W - 1 - px) << 1)) & 3
          if (pal === 0)
            continue
          const palet = paletHigh + pal
          const col = vram[paletTable + palet] & 0x3f
          const c = col * 3
          const index = ((y + py) * LINE_WIDTH + (x + px)) * 4
          pixels[index + 0] = kColors[c]
          pixels[index + 1] = kColors[c + 1]
          pixels[index + 2] = kColors[c + 2]
        }
      }
    }
  }

  public dumpVram(start: number, count: number): void {
    const mem = []
    for (let i = 0; i < count; ++i) {
      mem.push(this.vram[getPpuAddr(start + i, this.mirrorModeBit)])
    }

    for (let i = 0; i < count; i += 16) {
      const line = mem.splice(0, 16).map(x => Util.hex(x, 2)).join(' ')
      console.log(`${Util.hex(start + i, 4)}: ${line}`)
    }
  }

  public renderPattern(pixels: Uint8ClampedArray, lineWidth: number, colors: number[]): void {
    const W = 8
    for (let i = 0; i < 2; ++i) {
      for (let by = 0; by < 16; ++by) {
        for (let bx = 0; bx < 16; ++bx) {
          const chridx = (bx + by * 16 + i * 256) * 16
          for (let py = 0; py < W; ++py) {
            const yy = by * W + py
            const idx = chridx + py
            const pat = ((kStaggered[this.readPpuDirect(idx + 8)] << 1) |
                         kStaggered[this.readPpuDirect(idx)])
            for (let px = 0; px < W; ++px) {
              const xx = bx * W + px + i * (W * 16)
              const col = (pat >> ((W - 1 - px) << 1)) & 3
              const c = col * 3

              const index = (yy * lineWidth + xx) * 4
              pixels[index + 0] = colors[c + 0]
              pixels[index + 1] = colors[c + 1]
              pixels[index + 2] = colors[c + 2]
            }
          }
        }
      }
    }
  }

  public writePpuDirect(addr: number, value: number): void {
    if (addr >= 0x2000) {
      this.vram[addr] = value
    } else {
      const bankOffset = this.chrBankOffset[(addr >> 10) & 7]
      this.chrData[(addr & 0x3ff) + bankOffset] = value
    }
  }

  private checkSprite0Hit(hcount: number): void {
    if ((this.regs[PPUSTATUS] & SPRITE0HIT) !== 0 ||
        (this.regs[PPUMASK] & (SHOW_BG | SHOW_SPRITE)) !== (SHOW_BG | SHOW_SPRITE))
      return

    const sprite0y = this.oam[0]
    if (hcount < sprite0y || hcount >= sprite0y + 16)
      return
    const sprite0x = this.oam[3]
    if (sprite0x >= 255)
      return

    const dy = this.getNonEmptySprite0Line()
    if (dy < 0 || hcount !== sprite0y + dy)
      return

    this.regs[PPUSTATUS] |= SPRITE0HIT
  }

  private getNonEmptySprite0Line() {
    const getSpritePat = (chridx, ppy) => {
      const idx = chridx + (ppy & 7) + ((ppy & 8) << 1)
      const bank = (idx >> 10) & 7
      const bankOfs = this.chrBankOffset[bank]
      const ofs = idx & 0x03ff
      const p = bankOfs + ofs
      let patHi = this.chrData[p + 8]
      let patLo = this.chrData[p]
      return (kStaggered[patHi] << 1) | kStaggered[patLo]
    }

    const oam = this.oam
    const chrStart = this.getSpritePatternTableAddress()
    const isSprite8x16 = this.isSprite8x16()
    const h = isSprite8x16 ? 16 : 8
    const i = 0
    const index = oam[i * 4 + 1]
    const attr = oam[i * 4 + 2]
    const flipVert = (attr & FLIP_VERT) !== 0
    const chridx = (isSprite8x16
                    ? (index & 0xfe) * 16 + ((index & 1) << 12)
                    : index * 16 + chrStart)

    for (let py = 0; py < h; ++py) {
      const ppy = flipVert ? (h - 1) - py : py
      const pat = getSpritePat(chridx, ppy)
      if (pat !== 0)
        return py
    }
    return -1
  }

  private addHevent(param: any): void {
    let hcount = this.hcount
    if (hcount >= 240)
      hcount = 0
    const hevents = this.hevents
    let n = hevents.count
    if (n <= 0 || hevents.events[n - 1].hcount !== hcount) {
      if (++n >= hevents.events.length) {
        hevents.events.push({})
      }
    }
    let event = hevents.events[n - 1]
    event.hcount = hcount
    Object.keys(param).forEach(key => {
      event[key] = param[key]
    })
    hevents.count = n
  }

  private readPpuDirect(addr: number): number {
    if (addr >= 0x2000) {
      return this.vram[addr]
    } else {
      const bankOffset = this.chrBankOffset[(addr >> 10) & 7]
      return this.chrData[(addr & 0x3ff) + bankOffset]
    }
  }
}
