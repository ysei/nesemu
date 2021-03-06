// UxROM

import {Cpu} from '../cpu.ts'
import {Ppu} from '../ppu.ts'

function mapper002Creator(prgBankShift) {
  return function (romData: Uint8Array, cpu: Cpu, _ppu: Ppu) {
    const BANK_BIT = 14
    const BANK_SIZE = 1 << BANK_BIT
    const size = romData.length
    const count = size / BANK_SIZE
    const kLastBank = size - BANK_SIZE
    let prgBank = 0
    cpu.setReadMemory(0x8000, 0xbfff, (adr) => romData[(adr & (BANK_SIZE - 1)) + prgBank])
    cpu.setReadMemory(0xc000, 0xffff,
                      (adr) => romData[(adr & (BANK_SIZE - 1)) + kLastBank])

    // PRG ROM bank
    cpu.setWriteMemory(0x8000, 0xffff, (_adr, value) => {
      prgBank = ((value >> prgBankShift) & (count - 1)) << BANK_BIT
    })
  }
}

export const mapper002 = mapper002Creator(0)

// INES Mapper 093: Sunsoft-2 IC
// http://wiki.nesdev.com/w/index.php/INES_Mapper_093
// This mapper is deprecated for new development. Homebrew projects other than mapper tests should
// use UxROM (iNES Mapper 002) instead.
export const mapper093 = mapper002Creator(4)
