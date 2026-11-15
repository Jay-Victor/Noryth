import type { Appearance, AppearancePatch } from '../../../shared/schema/settings'
import { useSettings } from '../../stores/settings'

/** 外观（UI-DESIGN §8.3 / PHASE-10 I4）：切换即预览，只改 token。 */

const THEMES: Array<{ key: Appearance['theme']; name: string; desc: string }> = [
  { key: 'light', name: '明亮', desc: '纸面与墨色，默认' },
  { key: 'dark', name: '暗色', desc: '夜间写作，低亮度' },
  { key: 'system', name: '跟随系统', desc: '随 Windows 主题切换' }
]

const ACCENTS: Array<{ key: Appearance['accent']; name: string; color: string }> = [
  { key: 'clay', name: '陶土', color: '#a6552f' },
  { key: 'ink', name: '墨蓝', color: '#3c5a7a' },
  { key: 'moss', name: '苔绿', color: '#4a6b4f' },
  { key: 'plum', name: '梅紫', color: '#7a4468' },
  { key: 'slate', name: '石青', color: '#4c4a46' }
]

const FONT_SCALES: Array<{ key: Appearance['fontScale']; name: string; px: string }> = [
  { key: 'small', name: '小', px: '14' },
  { key: 'standard', name: '标准', px: '15' },
  { key: 'large', name: '大', px: '16' }
]

const LINE_HEIGHTS: Array<{ key: Appearance['lineHeight']; name: string }> = [
  { key: 1.6, name: '紧凑 1.6' },
  { key: 1.8, name: '标准 1.8' },
  { key: 2.0, name: '宽松 2.0' }
]

export function AppearanceSection(): React.JSX.Element {
  const appearance = useSettings((state) => state.view?.appearance ?? null)
  const save = useSettings((state) => state.appearance)
  if (!appearance) return <section className="side-card">正在读取外观设置…</section>

  const update = (patch: AppearancePatch): void => {
    void save(patch)
  }

  return (
    <>
      <section className="side-card">
        <h2>主题</h2>
        <div className="settings-themes">
          {THEMES.map((theme) => (
            <button
              key={theme.key}
              type="button"
              className="settings-theme"
              data-selected={appearance.theme === theme.key}
              data-testid={`theme-card-${theme.key}`}
              onClick={() => update({ theme: theme.key })}
            >
              <span className={`settings-theme__preview settings-theme__preview--${theme.key}`}>
                <i />
                <i />
                <i />
              </span>
              <b>{theme.name}</b>
              <small>{theme.desc}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="side-card">
        <h2>强调色</h2>
        <div className="settings-accents">
          {ACCENTS.map((accent) => (
            <button
              key={accent.key}
              type="button"
              className="settings-accent"
              data-selected={appearance.accent === accent.key}
              title={accent.name}
              onClick={() => update({ accent: accent.key })}
            >
              <span style={{ background: accent.color }} />
              {accent.name}
            </button>
          ))}
        </div>
        <p className="settings-hint">只改强调色，状态色（成功/警告/危险）保持语义不变。</p>
      </section>

      <section className="side-card">
        <h2>正文排版</h2>
        <div className="settings-row">
          <span className="settings-row__label">字号</span>
          <div className="settings-segment">
            {FONT_SCALES.map((scale) => (
              <button
                key={scale.key}
                type="button"
                data-selected={appearance.fontScale === scale.key}
                onClick={() => update({ fontScale: scale.key })}
              >
                {scale.name} {scale.px}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-row__label">行距</span>
          <div className="settings-segment">
            {LINE_HEIGHTS.map((lineHeight) => (
              <button
                key={String(lineHeight.key)}
                type="button"
                data-selected={appearance.lineHeight === lineHeight.key}
                onClick={() => update({ lineHeight: lineHeight.key })}
              >
                {lineHeight.name}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-prose-preview" data-testid="appearance-preview">
          雨落在祠堂的瓦上。她把茶盏往他那边推了推，声音压得很低，像是怕被窗外的雨听见。
          「我只问一句。」
        </div>
        <p className="settings-hint">排版只影响阅读与编辑，不影响导出文件。</p>
      </section>
    </>
  )
}
