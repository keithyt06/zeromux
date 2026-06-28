import { describe, it, expect } from 'vitest'
import { deepLinkView } from '../deeplink'

describe('deepLinkView', () => {
  it('git when dirty', () => expect(deepLinkView(2)).toBe('git'))
  it('none when clean', () => expect(deepLinkView(0)).toBe('none'))
})
