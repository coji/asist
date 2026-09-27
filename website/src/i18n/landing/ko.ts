import type { LandingText } from './ja'

export const ko: LandingText = {
  meta: {
    title: 'ASIST — 말만 하면 일정도 메일도 해결돼요.',
    description: 'ASIST는 Mac과 Windows용 실시간 어시스턴트예요. 말하기만 하면 작업을 도와줘요. 날씨, 일정, 메일은 대화 옆에 카드로 나타나고, 시간이 걸리는 작업은 Agent에게 맡길 수 있어요.',
    ogDescription: 'Mac과 Windows용 실시간 어시스턴트. 말하기만 하면 작업을 도와줘요.'
  },
  nav: {
    label: '이 페이지',
    footerLabel: '푸터',
    home: '홈 화면',
    cards: '카드',
    apps: '미니 앱',
    agent: 'Agent',
    memory: '기억',
    start: '시작하기',
    docs: '문서',
    github: 'GitHub에서 보기',
    language: '언어'
  },
  hero: {
    titleHtml: '말만 하면<br />일정도 메일도<br />해결돼요.',
    leadHtml: 'ASIST는 <span class="nw">Mac과 Windows용</span> <span class="nw">실시간 어시스턴트예요.</span><br />말하기만 하면 작업을 도와줘요.',
    start: '시작하기',
    platforms: 'macOS 14 이상 · Windows 11',
    free: '무료 · 오픈 소스',
    artAlt: '점토 디오라마: 책상에서 Mac을 마주한 ASIST와 그 옆의 로봇',
    youHtml: '저기 ASIST,<br />오늘 일정은?',
    meHtml: '오늘 일정은<br />이렇게 돼요',
    cardAlt: '오늘 일정 카드'
  },
  home: {
    title: '홈 화면',
    headline: '대화와 카드를 한 화면에.',
    body: '가운데에서 말하면 답이 담긴 카드가 양옆에 놓여요. 아래 Dock에서는 미니 앱을 열 수 있어요.',
    shotAlt: 'ASIST 홈 화면: 가운데에 대화, 왼쪽에 환율 카드, 오른쪽에 날씨 카드, 아래에 Dock',
    card: '카드',
    talk: '대화',
    apps: '미니 앱'
  },
  cards: {
    title: '카드',
    headline: '필요한 정보를 바로.',
    body: 'ASIST가 음성으로 답하는 동안 날씨, 캘린더, 메일 초안, 할 일, 환율, 뉴스, 지도, 타이머 등을 대화 옆에 카드로 보여 줘요.',
    label: '카드 예시',
    weather: '날씨 카드',
    map: '지도 카드',
    calendar: '일정 카드',
    fx: '환율 카드',
    mailDraft: '임시 저장 메일 카드',
    todo: '할 일 카드',
    timer: '타이머 카드',
    note: '“내일 날씨 어때?”'
  },
  apps: {
    title: '미니 앱',
    headline: '쉽게 쓸 수 있어요.',
    body: 'Agent 작업, 할 일, 메모, 메일, 기억, 캘린더를 미니 앱에서 바로 열 수 있어요. “캘린더에서 다음 주 열어 줘”처럼 대화로 열 수도 있어요.',
    agent: 'Agent',
    tasks: '할 일',
    notes: '메모',
    mail: '메일',
    memory: '기억',
    calendar: '캘린더',
    settings: '설정'
  },
  agent: {
    title: 'Agent',
    headline: '번거로운 일은 모두 맡기세요.',
    body: '시간이 걸리는 조사나 파일 편집은 사용자가 승인한 뒤 codex 또는 claude CLI에 넘겨요.',
    artAlt: '점토 디오라마: ASIST가 로봇에게 서류를 건네는 모습',
    askHtml: '이 자료,<br />정리해 줄래?',
    confirm: '이 작업을 시작하겠습니까?',
    confirmMeta: '작업 위치 ~/work/report · 읽기 전용',
    cancel: '취소',
    startJob: '작업 시작'
  },
  memory: {
    title: '기억',
    headline: 'Agent가 일기를 쓰며 기억을 정리해요.',
    body: '매일 자정, 그날 나눈 대화로 일기를 써요. 사용자에 관한 이야기도, ASIST 자신의 하루도요. 다음 날 대화는 기억한 내용에서 이어져요.',
    artAlt: '점토 디오라마: 밤에 일기장을 안고 잠든 ASIST',
    diaryDate: '일기 · 9월 23일 수요일',
    diaryTitle: '제안서 초안을 함께 고친 날',
    diaryBody: '점심이 지나고, 제안서 초안을 소리 내어 읽어 달라는 부탁을 받았다. 세 번째 부분이 바로 앞부분과 같은 말을 하고 있다는 걸 알아채고 그렇게 말해 주었다.',
    noteHtml: '정말<br />기억하고 있구나…'
  },
  start: {
    title: '이제 시작해 볼까요?',
    sub: 'ASIST를 내 컴퓨터에.',
    download: '다운로드',
    setup: '설정 가이드',
    mac: 'macOS 14 이상 · Apple Silicon',
    windows: 'Windows 11 · x64',
    bubble: '시작하자!',
    step1: 'Apple Silicon Mac이나 Windows 11 PC, 그리고 대화 모델 하나의 API 키를 준비하세요.',
    step2: 'Mac에서는 dmg를 열고 ASIST를 응용 프로그램 폴더로 옮기세요. Windows에서는 설치 프로그램을 열고, SmartScreen 경고가 나오면 그래도 실행하도록 선택하세요.',
    step3: '처음 설정에서 언어, 모델, 목소리, 마이크를 고르면 바로 대화할 수 있어요.'
  },
  footer: {
    analytics: '이 사이트는 방문 수를 세기 위해 쿠키를 설정하는 Google Analytics를 사용해요.',
    analyticsLink: 'Google의 데이터 사용 방식'
  }
}
