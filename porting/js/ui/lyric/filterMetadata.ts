const timeFieldExp = /^(?:\s*\[[\d:.]+\])+/

const creditLabelExp =
  /^(?:作词|作曲|编曲|制作|制作人|监制|出品|出品人|发行|词|曲|录音|录音师|录音助理|录音工程|录音工程师|混音|混音师|混音助理|混音工程|混音工程师|母带|母带后期|母带工程师|音频工程师|主人声|人声|人声录音|人声编辑|和声|合声|合声编写|和音|配唱|配唱制作人|吉他|贝斯|低音吉他|鼓|键盘|弦乐|弦乐编写|制作助理|制作统筹|统筹|企划|宣传|版权|录音棚|录音室|录音地点|录音时间|ISRC|OP|SP)\s*[:：]/i

const creditPhraseExp =
  /^(?:Producers?|Co-Producers?|Lyricists?|Composers?|Arrangers?|Mixing(?:\s+(?:Assistant|Engineer))?|Mastering(?:\s+Engineer)?|Engineering|Engineer|Recording(?:\s+(?:Assistant|Engineer))?|Vocal(?:\s+(?:Producer|Engineer|Editing))?|Backing\s+Vocals?|Keyboards?|Guitars?|Drums?|Percussion|Lead\s*&\s*Background\s+Vocals|Studio|Recorded\s+at)\s*[:：]/i

const creditLineExp =
  /^(?:Published\s+by|Recorded\s+at|Mixed\s+at|Mastered\s+at|Produced\s+by|Co-produced\s+by|Recorded\s+by|Mixed\s+by|Mastered\s+by)\s+/i

const firstTimestampExp = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/
const titleArtistLineExp = /^.+?\s+-\s+.+$/

const getFirstTimestamp = (line: string): number => {
  const match = line.match(firstTimestampExp)
  if (!match) return Number.POSITIVE_INFINITY
  const milliseconds = match[3] ? Number(match[3].padEnd(3, '0').slice(0, 3)) : 0
  return (Number(match[1]) * 60 + Number(match[2])) * 1000 + milliseconds
}

const isEarlyTitleLine = (line: string, text: string): boolean => {
  return (
    getFirstTimestamp(line) <= 3000 &&
    text.length <= 80 &&
    titleArtistLineExp.test(text) &&
    !/[，。！？,.!?]/.test(text)
  )
}

/**
 * 部分音源会把制作人员表当成带时间戳的歌词行返回，例如：
 * `[00:00.000]作词 : 无`、`[00:01.000]作曲 : 无`。
 * 这些行不是唱词，直接交给歌词播放器会在歌曲开头/结尾显示成歌词。
 */
export const filterLyricMetadata = (lyric: string): string => {
  if (!lyric) return lyric

  return lyric
    .split(/\r\n|\n|\r/)
    .filter((line) => {
      const timeField = line.match(timeFieldExp)?.[0]
      if (!timeField) return true

      const text = line.slice(timeField.length).trim()
      if (!text) return true

      return (
        !isEarlyTitleLine(line, text) &&
        !creditLabelExp.test(text) &&
        !creditPhraseExp.test(text) &&
        !creditLineExp.test(text)
      )
    })
    .join('\n')
}
