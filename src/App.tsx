import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject, MouseEvent as ReactMouseEvent, ChangeEvent, ClipboardEvent as ReactClipboardEvent, PointerEvent as ReactPointerEvent, CSSProperties } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { availableMonitors, getCurrentWindow, LogicalPosition, LogicalSize } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { openUrl } from '@tauri-apps/plugin-opener';
import { check } from '@tauri-apps/plugin-updater';
import { exit, relaunch } from '@tauri-apps/plugin-process';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  register as registerGlobalShortcut,
  unregister as unregisterGlobalShortcut,
  unregisterAll as unregisterAllGlobalShortcuts
} from '@tauri-apps/plugin-global-shortcut';
import './styles.css';
import {
  applyLowMode,
  generateRoomId,
  listMediaDevices,
  normalizeRoomId,
  RealtimeRoom,
  MAX_ATTACHMENT_BYTES,
  INLINE_PREVIEW_MAX_BYTES
} from './services/realtime';
import {
  clearAllLocalData,
  clearRoomMessages,
  initDb,
  loadMessages,
  loadProfile,
  loadSettings,
  markMessageDeleted,
  saveMessage,
  saveProfile,
  saveSettings,
  DEFAULT_SETTINGS,
  DEFAULT_HOTKEYS,
  DEFAULT_CAMERA_OVERLAY,
  DEFAULT_SCREEN_RECORDER
} from './services/db';
import {
  ScreenRecorderController,
  finalizeRecoverableScreenRecording,
  getScreenRecorderDependencyStatus,
  listRecoverableScreenRecordings,
  openScreenRecordingsFolder,
  prepareScreenRecorderDependencies
} from './services/screenRecorder';
import type {
  RecoverableScreenRecording,
  RecorderDependencyStatus,
  ScreenRecorderRuntimeState,
  ScreenRecorderSourceInfo,
  ScreenRecorderAudioLevels
} from './services/screenRecorder';
import type { AppLanguage, AppSettings, ChatMessage, ChatOverlaySettings, CameraOverlaySettings, ConnectionState, PeerProfile, ScreenFps, ScreenQuality, ScreenRecorderSettings, UserProfile } from './types/models';
import {
  fetchProfileAssets,
  MAX_PROFILE_SOURCE_IMAGE_BYTES,
  profileAvatarVersion,
  publishProfileAvatar,
  type ProfileAssetAccess
} from './services/profileAssets';

const EMOJIS = ['😀', '😂', '😍', '🔥', '❤️', '👍', '👏', '😎', '😢', '😡', '🙏', '🎉', '💯', '✨', '👀', '✅', '❌', '⚡', '🌟', '😴', '🤝', '💪', '🎮', '🫡', '🤣', '🥲', '😅', '🙌', '🌹', '💙'];
const INSTAGRAM_URL = 'https://www.instagram.com/m.ed1t/';
const APP_VERSION = '0.9.1';

const LOCALIZED_TEXT: Record<AppLanguage, Record<string, string>> = {
  ar: {
    boot: 'جاري تشغيل MHTalk...',
    connection: 'الاتصال',
    startRoom: 'ابدأ غرفة خاصة',
    startRoomDesc: 'أنشئ غرفة وأرسل الكود لصديقك، أو أدخل كود غرفة وصل لك. بعد الدخول تختار تفعيل المايك أو البقاء ميوت.',
    createRoom: 'إنشاء روم',
    joinRoom: 'انضمام لروم',
    waiting: 'بانتظار الأصدقاء...',
    choosePeer: 'اختر صديقاً من الدوائر العلوية لعرض بث الشاشة هنا',
    copyCode: 'نسخ الكود',
    endCall: 'غلق الاتصال',
    stopVoice: 'إيقاف الصوت',
    startVoice: 'بدء الصوت',
    muteMic: 'كتم المايك',
    unmuteMic: 'فتح المايك',
    stopShare: 'إيقاف مشاركة الشاشة',
    shareScreen: 'مشاركة الشاشة',
    refreshAudio: 'تحديث أجهزة الصوت',
    screenQuality: 'جودة الشاشة',
    screenFps: 'عدد الإطارات',
    applySettings: 'حفظ / تطبيق',
    settingsSaved: 'تم حفظ الإعدادات.',
    unsavedSettings: 'تغييرات غير محفوظة',
    saveChat: 'حفظ المحادثات محلياً',
    friendsInRoom: 'الأصدقاء داخل الروم',
    nobody: 'ماكو أحد متصل بعد.',
    showStream: 'عرض بثه',
    privateMessage: 'رسالة خاصة',
    kickMember: 'طرد من الروم',
    kickConfirm: 'هل تريد طرد هذا العضو من الروم؟',
    kickedOut: 'تم طردك من الروم.',
    kickedMember: 'تم طرد العضو من الروم.',
    ownerOnly: 'هذا الخيار لصاحب الروم فقط.',
    callVolume: 'صوت المكالمة',
    screenVolume: 'صوت البث',
    muteCall: 'إسكات صوت المكالمة',
    unmuteCall: 'تشغيل صوت المكالمة',
    muteScreen: 'إسكات صوت البث',
    unmuteScreen: 'تشغيل صوت البث',
    deleteRoomHistory: 'حذف سجل الغرفة',
    deleteAllLocalData: 'حذف كل البيانات المحلية',
    reply: 'رد',
    edit: 'تعديل',
    edited: 'تم التعديل',
    saveEdit: 'حفظ التعديل',
    cancel: 'إلغاء',
    send: 'إرسال',
    writeMessage: 'اكتب رسالة...',
    privateTo: 'رسالة خاصة إلى',
    replyTo: 'رد على',
    editingMessage: 'تعديل الرسالة',
    profileSettings: 'إعدادات الحساب',
    localAccount: 'تعديل الحساب المحلي',
    name: 'الاسم',
    email: 'الإيميل / الحساب',
    status: 'الحالة',
    bio: 'نبذة',
    avatar: 'صورة شخصية',
    profileImageTooLarge: 'يجب أن يكون حجم صورة الملف الشخصي أقل من 32MB.',
    banner: 'خلفية',
    language: 'اللغة',
    screenRecorder: 'مسجل الشاشة',
    screenRecorderTitle: 'تسجيل البث والشاشة',
    screenRecorderHint: 'سجّل بث الشاشة الحالي مباشرة إلى جهازك بإعدادات خفيفة ومتكيّفة.',
    screenRecorderIdle: 'جاهز للتسجيل',
    screenRecorderStarting: 'جاري بدء التسجيل…',
    screenRecorderRecording: 'جاري التسجيل',
    screenRecorderPaused: 'التسجيل متوقف مؤقتاً',
    screenRecorderStopping: 'جاري حفظ التسجيل…',
    screenRecorderError: 'خطأ في التسجيل',
    screenRecorderQuality: 'جودة التسجيل',
    screenRecorderQualityAdaptive: 'متكيّفة مع الجهاز',
    screenRecorderQualityHigh: 'جودة عالية',
    screenRecorderQualityBalanced: 'متوازنة',
    screenRecorderQualityPerformance: 'خفيفة على الجهاز',
    screenRecorderFps: 'إطارات التسجيل',
    screenRecorderFpsMatch: 'مطابقة البث',
    screenRecorderCodec: 'ترميز الفيديو',
    screenRecorderCodecAuto: 'تلقائي (موصى به)',
    screenRecorderIncludeAudio: 'تسجيل صوت البث',
    screenRecorderAutoStart: 'بدء التسجيل تلقائياً مع البث',
    screenRecorderSource: 'مصدر البث',
    screenRecorderSourceUnavailable: 'ابدأ مشاركة الشاشة',
    screenRecorderEstimatedSize: 'الحجم التقديري',
    screenRecorderAdaptiveEstimate: 'يُحسب عند البدء',
    screenRecorderStart: 'بدء التسجيل',
    screenRecorderPause: 'إيقاف مؤقت',
    screenRecorderResume: 'متابعة التسجيل',
    screenRecorderStop: 'إيقاف وحفظ',
    screenRecorderOpenFolder: 'فتح مجلد التسجيلات',
    screenRecorderSaveSettings: 'حفظ الإعدادات',
    screenRecorderSettingsSaved: 'تم حفظ إعدادات تسجيل الشاشة.',
    screenRecorderNeedsStream: 'ابدأ مشاركة الشاشة أولاً حتى تتمكن من تسجيل البث.',
    screenRecorderSaved: 'تم حفظ التسجيل',
    screenRecorderSaveFailed: 'تعذر تسجيل البث أو حفظه',
    screenRecorderLocalOnly: 'يُحفظ محلياً فقط',
    screenRecorderAudioUnavailable: 'البث الحالي لا يحتوي على مسار صوتي، لذلك سيُسجل الفيديو دون صوت.',
    screenRecorderFile: 'ملف التسجيل',
    screenRecorderPerformanceNote: 'يستخدم المسجل نفس بث الشاشة الحالي دون فتح التقاط ثانٍ، ويكيّف الإطارات ومعدل البيانات لتقليل الضغط على الجهاز.',
    screenRecorderSettingsOnly: 'هذه النافذة لضبط إعدادات التسجيل فقط. ابدأ أو أوقف التسجيل من الزر القريب من زر مشاركة الشاشة.',
    screenRecorderToolbarStart: 'بدء تسجيل البث',
    screenRecorderToolbarStop: 'إيقاف التسجيل وحفظ MP4',
    screenRecorderArmed: 'جاري بدء البث والتسجيل…',
    screenRecorderMp4Hint: 'عند إيقاف التسجيل أو البث، يُغلق التسجيل أولاً ثم يُحوّل تلقائياً إلى MP4.',
    screenRecorderRepair: 'حل التسجيل التالف',
    screenRecorderRepairTitle: 'استعادة تسجيل غير مكتمل',
    screenRecorderRepairHint: 'اختر استكمال التسجيل السابق في جزء جديد، أو إيقافه وإصلاح الأجزاء المحفوظة ثم إخراج ملف MP4.',
    screenRecorderNoRecovery: 'لا توجد تسجيلات غير مكتملة تحتاج إلى إصلاح.',
    screenRecorderResumePrevious: 'استكمال التسجيل السابق',
    screenRecorderStopAndSaveMp4: 'إيقافه وحفظه MP4',
    screenRecorderRecoveryDate: 'آخر حفظ',
    screenRecorderRecoverySize: 'الحجم المحفوظ',
    screenRecorderRecoverySegments: 'أجزاء',
    screenRecorderRecoveryStarted: 'تم استكمال التسجيل السابق.',
    screenRecorderRecoverySaved: 'تم إصلاح التسجيل وحفظه بصيغة MP4',
    screenRecorderRepairFailed: 'تعذر إصلاح التسجيل',
    screenRecorderFinalizingMp4: 'جاري تجهيز MP4…',
    screenRecorderDependencyPreparing: 'يتم تجهيز محوّل MP4 في الخلفية دون مقاطعتك.',
    screenRecorderDependencyReady: 'محوّل MP4 جاهز.',
    screenRecorderDependencyFailed: 'تعذر تجهيز محوّل MP4 تلقائياً.',
    recorderMyMic: 'المايكروفون الخاص بي',
    recorderMembers: 'أصوات الأعضاء',
    recorderSystem: 'صوت النظام / اللعبة',
    recorderAutoDuck: 'خفض صوت النظام تلقائياً عند الكلام',
    recorderMicDevice: 'مايكروفون التسجيل',
    recorderOutputDevice: 'مخرج أصوات الأعضاء',
    recorderMasterMeter: 'مستوى المزيج النهائي',
    recorderMuteSource: 'كتم هذا المصدر',
    recorderFinalizationSafe: 'تم حفظ نسخة آمنة فوراً، ويجري تجهيز MP4 في الخلفية.',
    fileActions: 'خيارات الملف',
    downloadToDesktop: 'تحميل إلى سطح المكتب',
    saveAs: 'حفظ باسم',
    downloadProgress: 'تقدم الحفظ',
    fileSaved: 'تم حفظ الملف',
    fileSaveFailed: 'تعذر حفظ الملف',
    overlayInteractive: 'الوضع التفاعلي',
    overlayClickThrough: 'وضع المرور عبر النقرات',
    overlayMonitor: 'الشاشة',
    overlayModeHotkey: 'تبديل وضع أوفرلاي الدردشة',
    overlayFullscreenLimit: 'قد تمنع بعض الألعاب المحمية أو وضع ملء الشاشة الحصري ظهور الأوفرلاي؛ استخدم Borderless عند الحاجة.',
    overlayModeChanged: 'تم تغيير وضع الأوفرلاي',
    notifications: 'الإشعارات',
    fullscreen: 'تكبير الشاشة',
    exitFullscreen: 'تصغير الشاشة',
    pip: 'PiP فوق التطبيقات',
    roomId: 'كود الروم',
    mic: 'المايك',
    speaker: 'السماعة',
    defaultDevice: 'الافتراضي',
    lowInternet: 'وضع النت الضعيف',
    lowPc: 'وضع الجهاز الضعيف',
    audioOnlyHint: 'وضع الصوت فقط مفعّل: غيّر جودة الشاشة إذا تريد مشاركة الشاشة.',
    micPermission: 'تعذر تشغيل المايك. تأكد من السماح بالوصول للمايك.',
    screenPermission: 'تعذر بدء مشاركة الشاشة. اختر نافذة/شاشة تدعم مشاركة الصوت إذا تريد صوت الفيديو.',
    roomOpened: 'تم فتح الغرفة. الاتصال يبدأ تلقائياً عند دخول الأصدقاء.',
    micAutoStart: 'اسمح للمايك حتى يبدأ الاتصال الصوتي تلقائياً.',
    micJoinTitle: 'تشغيل المايك؟',
    micJoinDesc: 'اختر هل تريد تفعيل المايك الآن أو البقاء مكتوماً داخل الروم.',
    activateMicNow: 'تفعيل المايك',
    stayMuted: 'البقاء ميوت',
    historyForNewMembers: 'إظهار الرسائل القديمة للأعضاء الجدد',
    historySyncedToNewMember: 'تم إرسال سجل الرسائل للعضو الجديد.',
    cameraWillStartWithStream: 'سيتم تشغيل الكاميرا تلقائياً عند بدء البث.',
    cameraNeedsStream: 'وضع الكاميرا مع البث يعمل فقط أثناء مشاركة الشاشة.',
    invalidRoom: 'اكتب كود غرفة صحيح مثل MHLKO-7K9A-X2QF',
    confirmEndCall: 'هل أنت متأكد تريد غلق الاتصال؟',
    confirmCloseApp: 'هل أنت متأكد تريد غلق البرنامج؟',
    chatDisconnected: 'الشات غير متصل حالياً.',
    fileTypes: 'يمكن إرسال الصور والفيديو والصوت والملفات حتى 1GB.',
    sendingFile: 'جاري إرسال الملف...',
    fileFailed: 'تعذر إرسال الملف، الشات غير متصل.',
    fileTooLarge: 'الملف أكبر من حد 1GB أو لا يمكن إرساله بأمان.',
    fileSent: 'تم إرسال الملف.',
    voiceFailed: 'تعذر إرسال الرسالة الصوتية.',
    recordingStarted: 'بدأ تسجيل رسالة صوتية. اضغط مرة ثانية للإرسال.',
    recordingProblem: 'حدثت مشكلة أثناء تسجيل الرسالة الصوتية.',
    recordingDenied: 'تعذر تسجيل الصوت. تأكد من السماح للمايك.',
    copied: 'تم نسخ كود الغرفة.',
    dataProblem: 'تعذر تشغيل قاعدة البيانات المحلية. أعد فتح البرنامج.',
    chatCleared: 'تم حذف سجل هذه الغرفة من الجهاز.',
    confirmWipe: 'هل تريد حذف كل البيانات المحلية؟',
    dataWiped: 'تم حذف كل البيانات المحلية.',
    pipUnsupported: 'Picture in Picture غير مدعوم على هذا الجهاز.',
    pipStartFirst: 'شغل بث الشاشة أولاً ثم جرّب PiP.',
    placeholderEmail: 'اختياري',
    privateLabel: 'خاص',
    mediaLabel: 'وسائط',
    fileLabel: 'ملف',
    emojiTitle: 'إيموجي',
    attachTitle: 'صورة/فيديو/صوت',
    voiceTitle: 'رسالة صوتية',
    ownerBadge: 'صاحب الروم',
    me: 'أنا',
    state_idle: 'غير متصل',
    state_connecting: 'جاري الاتصال',
    state_connected: 'متصل',
    state_room_ready: 'الروم متصل - بانتظار الأعضاء',
    state_peer_connecting: 'جاري ربط الأعضاء',
    state_reconnecting: 'إعادة اتصال',
    state_disconnected: 'منقطع',
    state_failed: 'فشل الاتصال',
    typingOne: 'يكتب الآن...',
    typingMany: 'يكتبون الآن...',
    error_bad_signal: 'وصلت رسالة اتصال غير مفهومة.',
    error_signaling: 'تعذر الاتصال بخدمة الربط. تأكد من الإنترنت.',
    error_prepare_connection: 'تعذر تجهيز الاتصال، حاول مرة أخرى.',
    error_repair_connection: 'تعذر إصلاح الاتصال تلقائياً. جرّب الخروج والدخول للروم.',
    error_data_channel: 'حدثت مشكلة في قناة الشات.',
    error_bad_chat: 'وصلت رسالة شات غير مفهومة.',
    error_incomplete_file: 'ملف وصل ناقص بسبب ضعف الشبكة.',
    minimizeTitle: 'تصغير للتاسك بار',
    maximizeTitle: 'تكبير/تصغير',
    trayTitle: 'إخفاء للسستم تراي',
    deletedMessage: 'تم حذف الرسالة',
    deleteMessage: 'حذف',
    confirmDeleteMessage: 'هل تريد حذف هذه الرسالة؟',
    sendQueued: 'إرسال الصور/الملفات المحددة',
    pasteImage: 'تمت إضافة الصورة للإرسال.',
    openImage: 'فتح الصورة',
    download: 'تحميل',
    log_info: 'معلومة',
    log_error: 'خطأ',
    privateP2PRoom: 'غرفة خاصة P2P',
    chatOverlayEmpty: 'أوفرلاي المحادثة',
    videoPreview: 'معاينة الفيديو',
    dropFilesHere: 'أفلت الملفات هنا لإضافتها للإرسال',
    attachmentQueued: 'تمت إضافة الملف إلى الطابور.',
    bannedMembers: 'الأعضاء المطرودين',
    unban: 'السماح بالعودة',
    noBannedMembers: 'لا يوجد أعضاء مطرودين.',
    settingsPanel: 'الإعدادات',
    openSettings: 'فتح الإعدادات',
    closeSettings: 'إغلاق الإعدادات',
    screenAudioLimit: 'ملاحظة: عزل صوت برنامج معيّن من صوت الجهاز يحتاج دعم نظام تشغيل/تعريف صوت. تم فصل صوت البث عن صوت المكالمة داخل التطبيق قدر الإمكان.',
    closeTitle: 'خروج',
    state_waiting_approval: 'بانتظار موافقة المدير',
    joinRequests: 'طلبات الانضمام',
    noJoinRequests: 'لا توجد طلبات حالياً.',
    approve: 'قبول',
    reject: 'رفض',
    joinAccepted: 'تمت الموافقة على الدخول.',
    joinRejected: 'تم رفض طلب الدخول.',
    promoteModerator: 'إعطاء إشراف',
    moderatorBadge: 'مشرف',
    promotedMember: 'تم إعطاء الإشراف للعضو.',
    settingsButton: 'الإعدادات',
    adminBadge: 'ادمن',
    hotkeys: 'الاختصارات',
    errorLog: 'سجل الأحداث',
    noErrors: 'لا توجد أخطاء مسجلة.',
    clearLog: 'مسح اللوغ',
    close: 'إغلاق',
    pressHotkey: 'اضغط الاختصار الآن',
    clearHotkey: 'حذف الاختصار',
    hotkeySaved: 'تم حفظ الاختصار وتفعيله.',
    hotkeyDuplicate: 'هذا الاختصار مستخدم بالفعل',
    muteMicHotkey: 'كتم/فتح المايك',
    shareScreenHotkey: 'تشغيل/إيقاف البث',
    endCallHotkey: 'غلق الاتصال',
    fullscreenHotkey: 'تكبير/تصغير البث',
    toggleSettingsHotkey: 'فتح/إغلاق الإعدادات',
    holdVoiceHint: 'اضغط مطولاً للتسجيل، اترك الزر للمعاينة ثم اضغط إرسال.',
    voicePreview: 'رسالة صوتية جاهزة للإرسال',
    discardVoice: 'حذف التسجيل',
    streamVolume: 'صوت البث',
    playScreenOn: 'تم تشغيل البث',
    playScreenOff: 'تم إيقاف البث',
    userJoined: 'دخل عضو جديد',
    messageSending: 'جاري الإرسال...',
    messageSent: 'تم الإرسال',
    messageDelivered: 'تم التسليم',
    messageSeen: 'تمت المشاهدة',
    troubleshootConnection: 'إصلاح الاتصال',
    waitingApprovalTitle: 'بانتظار موافقة المدير',
    waitingApprovalDesc: 'تم إرسال طلب الانضمام. ابقَ هنا إلى أن يوافق المدير.',
    restartConnectionStarted: 'تمت إعادة تشغيل الاتصال بدون حذف الرسائل.',
    restartWatchedStream: 'إعادة تشغيل البث',
    watchedStreamRestarted: 'تمت إعادة تشغيل مسار البث فقط بدون الخروج من الروم.',
    nativeVoiceEngine: 'محرك الصوت Native',
    nativeVoiceEngineGroundwork: '0.8.5: يعمل صوت المكالمات داخل محرك MHTalkVoice مستقل ويُستثنى بالكامل من صوت بث النظام.',
    echoGuardActive: 'حماية الإيكو مفعلة: بث صوت النظام يستثني صوت الاتصال Native بدون كتم أعضاء المكالمة.',
    updateBootChecking: 'جاري فحص التحديثات قبل فتح البرنامج...',
    updateAutoInstalling: 'يوجد تحديث جديد. جاري التحديث تلقائياً...',
    checkUpdates: 'فحص التحديثات',
    checkingUpdates: 'جاري فحص التحديثات...',
    updateNone: 'لا يوجد تحديث جديد.',
    updateAvailable: 'يوجد تحديث جديد',
    updateInstall: 'تحديث الآن',
    updateInstalling: 'جاري تنزيل وتثبيت التحديث...',
    updateReady: 'تم تثبيت التحديث. سيتم إعادة تشغيل البرنامج.',
    updateFailed: 'فشل التحديث. تأكد من إعداد GitHub Releases و latest.json.',
    updateTimeout: 'انتهى وقت فحص التحديثات، سيتم فتح البرنامج بوضع offline.',
    updateRetry: 'إعادة المحاولة',
    continueOffline: 'المتابعة بدون اتصال',
    updateProgress: 'تقدم التحديث',
    updateRequiredTitle: 'تحديث إجباري متوفر',
    updateRequiredDesc: 'يجب تحديث MHTalk قبل المتابعة. اضغط تحديث الآن وسيتم التنزيل والتثبيت وإعادة التشغيل تلقائياً.',
    voiceSolutionsTitle: 'حلول إصلاح الصوت Native',
    voiceSolutionsHint: 'جرّب حل 1 ثم 2 ثم 3 ثم 4 أثناء الاتصال أو اختبار المايك، وبعدها خليك على الأفضل لصوت جهازك.',
    voiceSolutionApplied: 'تم تطبيق حل الصوت',
    voiceSolutionFailed: 'تعذر تطبيق حل الصوت',
    voiceEnhanceOn: 'Voice Enhance',
    voiceEnhanceOff: 'إيقاف تحسين الصوت',
    voiceEnhanceEnabled: 'تحسين الصوت مفعل',
    voiceEnhanceDisabled: 'تحسين الصوت مغلق',
    voiceEnhanceHint: 'يشغّل تقوية الصوت والوضوح والـ compressor للأعضاء. إذا صار تقطيع أو ثقل، أطفئه ويرجع الصوت الأساسي Native كما هو.',
    micTest: 'اختبار المايك',
    micTestStart: 'تشغيل اختبار المايك',
    micTestStop: 'إيقاف اختبار المايك',
    micTestHint: 'ستسمع صوت مايكك من السماعة المختارة. يفضل استخدام سماعات رأس حتى لا يصير صدى.',
    micTestFailed: 'تعذر تشغيل اختبار المايك. تأكد من السماح للمايك واختيار جهاز صحيح.',
    micLevel: 'مستوى المايك',
    closeStream: 'إغلاق البث',
    downloadLog: 'تحميل السجل TXT',
    logDownloaded: 'تم تحميل سجل الأحداث.',
    streamStarted: 'بدأ بث الشاشة.',
    streamEnded: 'انتهى بث الشاشة.',
    liveBadge: 'يبث',
    openFile: 'فتح الملف',
    status_sending: 'جاري الإرسال',
    status_receiving: 'جاري الاستلام',
    status_completed: 'مكتمل',
    status_failed: 'فشل',
    status_canceled: 'ملغي',
    youtubeVideo: 'فيديو يوتيوب',
    originalMessageMissing: 'الرسالة الأصلية غير موجودة في هذا السجل.',
    openStream: 'فتح البث',
    switchStream: 'تبديل البث',
    watchingStream: 'تتم المشاهدة',
    streamStopped: 'توقف البث',
    muteAllMembers: 'كتم كل الأعضاء',
    unmuteAllMembers: 'فتح كتم كل الأعضاء',
    raiseHand: 'رفع اليد',
    requestToSpeak: 'طلب الكلام',
    requestedPermissionToSpeak: 'طلب إذن الكلام',
    allowToSpeak: 'السماح بالكلام',
    rejectSpeakRequest: 'رفض الطلب',
    speakRequestCooldown: 'يمكنك طلب الكلام كل 15 ثانية',
    adminAllowedSpeak: 'سمح الأدمن للعضو بالكلام',
    adminRejectedSpeak: 'رفض الأدمن طلب الكلام',
    clearVoicePriority: 'أولوية وضوح الصوت',
    mutedByAdmin: 'تم كتمك من الأدمن',
    memberMutedByAdmin: 'مكتوم من الأدمن',
    muteForEveryone: 'كتمه للجميع',
    unmuteForEveryone: 'فتح كتمه للجميع',
    showChatOverlay: 'إظهار المحادثات على الشاشة',
    hideChatOverlay: 'إخفاء المحادثات من الشاشة',
    voiceAutoQuality: 'جودة الصوت تلقائية',
    streamAutoQuality: 'جودة البث تلقائية',
    networkWeakAdapting: 'الشبكة ضعيفة، يتم تعديل الجودة تلقائياً',
    streamQualityLimitedNetwork: 'تم تقليل جودة البث بسبب الشبكة',
    streamQualityLimitedDevice: 'تم تقليل جودة البث بسبب الجهاز',
    streamViewerClosed: 'تم إغلاق نافذة مشاهدة البث',
    streamViewerOpened: 'تم فتح نافذة مشاهدة البث',
    voiceProfileChanged: 'تم تغيير جودة الصوت تلقائياً',
    adminMutedAll: 'الأدمن كتم كل الأعضاء',
    chatOverlayShown: 'تم إظهار محادثات الشاشة',
    chatOverlayHidden: 'تم إخفاء محادثات الشاشة',
    waitingForMembers: 'بانتظار الأعضاء',
    roomReady: 'الروم جاهز',
    autoMaxQuality: 'تلقائي حسب الشاشة والشبكة',
    audioOnly: 'صوت فقط',
    chatOverlayCustomize: 'تخصيص أوفرلاي الدردشة',
    overlayEditorTitle: 'تعديل أوفرلاي الدردشة',
    overlayEditorHint: 'هذه مساحة تحاكي الشاشة. اسحب المربع وغير حجمه ومظهره كما تريد.',
    overlayOpacity: 'شفافية الأوفرلاي',
    overlayBorderRadius: 'حواف الأوفرلاي',
    overlayShowText: 'عرض الرسائل النصية',
    overlayShowImages: 'عرض الصور والوسائط',
    overlayShowAudio: 'عرض الصوتيات',
    overlayReset: 'إعادة ضبط الأوفرلاي',
    camera: 'الكاميرا',
    cameraSource: 'مصدر الكاميرا',
    cameraToggle: 'تشغيل/إيقاف الكاميرا',
    cameraUnavailable: 'الكاميرا غير متوفرة أو لم يتم السماح بها.',
    cameraMirror: 'عكس صورة الكاميرا',
    cameraOverlayHint: 'اسحب نافذة الكاميرا وغيّر حجمها داخل البث.',
    voicePriorityMax: 'أولوية الصوت القصوى',
    voicePriorityMaxHint: 'عند الضغط، يتم تخفيف البث والكاميرا والأوفرلاي قبل التأثير على الصوت.',
    cameraSettings: 'إعدادات الكاميرا',
    cameraModeTitle: 'اختر وضع الكاميرا',
    cameraModeHint: 'اختر هل تريد الكاميرا وحدها في مساحة البث أو مع بث الشاشة.',
    cameraWithStream: 'كاميرا مع البث',
    cameraOnlyMode: 'كاميرا بوحدها',
    cameraModeBack: 'رجوع',
    cameraOverlayCustomize: 'تخصيص مكان الكاميرا',
    cameraFitMode: 'طريقة عرض الكاميرا',
    cameraFitCover: 'ملء الإطار مع القص',
    cameraFitContain: 'إظهار الكاميرا كاملة',
    cameraCropX: 'موضع القص الأفقي',
    cameraCropY: 'موضع القص العمودي',
    cameraOpacity: 'شفافية الكاميرا',
    cameraEditorTitle: 'تعديل مربع الكاميرا',
    cameraEditorHint: 'حدد مكان وحجم الكاميرا داخل مساحة البث.',
    cameraStart: 'تشغيل الكاميرا',
    cameraStop: 'إيقاف الكاميرا',
    cameraOnly: 'الكاميرا فقط',
    viewCamera: 'مشاهدة الكاميرا',
    viewStream: 'مشاهدة البث',
    viewStreamOrCamera: 'اختر ما تريد مشاهدته',
    overlayPersisted: 'تم حفظ تخصيص الأوفرلاي.',
    attachmentReady: 'الملف جاهز للإرسال. اضغط Enter أو إرسال.',
    attachmentRejected: 'لا يمكن إرسال هذا الملف.',
    mediaCheckPassed: 'تم فحص الملف بسرعة وهو جاهز.',
    logInfo: 'معلومة',
    mediaDownloadToDesktop: 'تحميل إلى سطح المكتب',
    mediaCopy: 'نسخ',
    mediaSavedToDesktop: 'تم حفظ الوسائط على سطح المكتب.',
    mediaCopied: 'تم نسخ الوسائط.',
    mediaCopyFailed: 'تعذر نسخ الوسائط.',
    mediaDownloadFailed: 'تعذر تحميل الوسائط.',
    previewMyMedia: 'معاينة بثي/كامرتي',
    myMediaPreview: 'معاينة بثي وكامرتي',
    myScreenPreview: 'معاينة بث الشاشة',
    myCameraPreview: 'معاينة الكاميرا',
    myAudioPreview: 'اختبار الصوت',
    noSelfMediaPreview: 'شغّل البث أو الكاميرا حتى تظهر المعاينة.',
    localScreenPreviewHint: 'هذه معاينة محلية لبث الشاشة الحالي.',
    videoAttachment: 'فيديو',
    openVideo: 'تشغيل الفيديو',
    mediaContextTitle: 'خيارات الوسائط',
    friendFallback: 'صديق',
    typingSeparator: ' و ',
  },
  en: {
    boot: 'Starting MHTalk...',
    connection: 'Call',
    startRoom: 'Start a private room',
    startRoomDesc: 'Create a room and send the code to your friend, or enter a room code you received. After joining, choose whether to enable the microphone or stay muted.',
    createRoom: 'Create Room',
    joinRoom: 'Join Room',
    waiting: 'Waiting for friends...',
    choosePeer: 'Select a friend from the circles above to view their screen share here',
    copyCode: 'Copy code',
    endCall: 'End call',
    stopVoice: 'Stop voice',
    startVoice: 'Start voice',
    muteMic: 'Mute mic',
    unmuteMic: 'Unmute mic',
    stopShare: 'Stop screen share',
    shareScreen: 'Share screen',
    refreshAudio: 'Refresh audio devices',
    screenQuality: 'Screen quality',
    screenFps: 'FPS',
    applySettings: 'Save / Apply',
    settingsSaved: 'Settings saved.',
    unsavedSettings: 'Unsaved changes',
    saveChat: 'Save chats locally',
    friendsInRoom: 'People in room',
    nobody: 'No one is connected yet.',
    showStream: 'Show stream',
    privateMessage: 'Private message',
    kickMember: 'Kick from room',
    kickConfirm: 'Do you want to kick this member from the room?',
    kickedOut: 'You were kicked from the room.',
    kickedMember: 'Member was kicked from the room.',
    ownerOnly: 'Only the room owner can use this option.',
    callVolume: 'Call volume',
    screenVolume: 'Screen volume',
    muteCall: 'Mute call sound',
    unmuteCall: 'Unmute call sound',
    muteScreen: 'Mute stream sound',
    unmuteScreen: 'Unmute stream sound',
    deleteRoomHistory: 'Delete room history',
    deleteAllLocalData: 'Delete all local data',
    reply: 'Reply',
    edit: 'Edit',
    edited: 'Edited',
    saveEdit: 'Save edit',
    cancel: 'Cancel',
    send: 'Send',
    writeMessage: 'Write a message...',
    privateTo: 'Private message to',
    replyTo: 'Replying to',
    editingMessage: 'Editing message',
    profileSettings: 'Account settings',
    localAccount: 'Edit local account',
    name: 'Name',
    email: 'Email / Account',
    status: 'Status',
    bio: 'Bio',
    avatar: 'Avatar',
    profileImageTooLarge: 'Profile images must be smaller than 32MB.',
    banner: 'Banner',
    language: 'Language',
    screenRecorder: 'Screen Recorder',
    screenRecorderTitle: 'Screen & Broadcast Recorder',
    screenRecorderHint: 'Record your current screen broadcast directly to your device with lightweight, adaptive settings.',
    screenRecorderIdle: 'Ready to record',
    screenRecorderStarting: 'Starting recorder…',
    screenRecorderRecording: 'Recording',
    screenRecorderPaused: 'Recording paused',
    screenRecorderStopping: 'Saving recording…',
    screenRecorderError: 'Recording error',
    screenRecorderQuality: 'Recording quality',
    screenRecorderQualityAdaptive: 'Adaptive to device',
    screenRecorderQualityHigh: 'High quality',
    screenRecorderQualityBalanced: 'Balanced',
    screenRecorderQualityPerformance: 'Performance saver',
    screenRecorderFps: 'Recording frame rate',
    screenRecorderFpsMatch: 'Match broadcast',
    screenRecorderCodec: 'Video codec',
    screenRecorderCodecAuto: 'Automatic (recommended)',
    screenRecorderIncludeAudio: 'Record broadcast audio',
    screenRecorderAutoStart: 'Start automatically with screen share',
    screenRecorderSource: 'Broadcast source',
    screenRecorderSourceUnavailable: 'Start screen sharing',
    screenRecorderEstimatedSize: 'Estimated size',
    screenRecorderAdaptiveEstimate: 'Calculated on start',
    screenRecorderStart: 'Start recording',
    screenRecorderPause: 'Pause',
    screenRecorderResume: 'Resume',
    screenRecorderStop: 'Stop and save',
    screenRecorderOpenFolder: 'Open recordings folder',
    screenRecorderSaveSettings: 'Save settings',
    screenRecorderSettingsSaved: 'Screen recorder settings saved.',
    screenRecorderNeedsStream: 'Start screen sharing before recording the broadcast.',
    screenRecorderSaved: 'Recording saved',
    screenRecorderSaveFailed: 'Could not record or save the broadcast',
    screenRecorderLocalOnly: 'Saved locally only',
    screenRecorderAudioUnavailable: 'The current broadcast has no audio track, so the video will be recorded without audio.',
    screenRecorderFile: 'Recording file',
    screenRecorderPerformanceNote: 'The recorder reuses the current screen stream without starting a second capture and adapts frame rate and bitrate to reduce device load.',
    screenRecorderSettingsOnly: 'This window is only for recording settings. Start or stop recording from the button beside Screen Share.',
    screenRecorderToolbarStart: 'Start broadcast recording',
    screenRecorderToolbarStop: 'Stop recording and save MP4',
    screenRecorderArmed: 'Starting screen share and recording…',
    screenRecorderMp4Hint: 'When recording or screen sharing stops, capture closes first and is then converted automatically to MP4.',
    screenRecorderRepair: 'Repair interrupted recording',
    screenRecorderRepairTitle: 'Recover an incomplete recording',
    screenRecorderRepairHint: 'Continue the previous recording in a new safe segment, or stop it and repair the saved segments into an MP4 file.',
    screenRecorderNoRecovery: 'There are no incomplete recordings to repair.',
    screenRecorderResumePrevious: 'Continue previous recording',
    screenRecorderStopAndSaveMp4: 'Stop it and save MP4',
    screenRecorderRecoveryDate: 'Last saved',
    screenRecorderRecoverySize: 'Saved size',
    screenRecorderRecoverySegments: 'segments',
    screenRecorderRecoveryStarted: 'The previous recording is being continued.',
    screenRecorderRecoverySaved: 'Recording repaired and saved as MP4',
    screenRecorderRepairFailed: 'Could not repair the recording',
    screenRecorderFinalizingMp4: 'Preparing MP4…',
    screenRecorderDependencyPreparing: 'The MP4 converter is being prepared quietly in the background.',
    screenRecorderDependencyReady: 'The MP4 converter is ready.',
    screenRecorderDependencyFailed: 'The MP4 converter could not be prepared automatically.',
    recorderMyMic: 'My microphone',
    recorderMembers: 'Other members’ voices',
    recorderSystem: 'System / game audio',
    recorderAutoDuck: 'Automatically lower system audio while voices are active',
    recorderMicDevice: 'Recording microphone',
    recorderOutputDevice: 'Members’ output device',
    recorderMasterMeter: 'Final mix level',
    recorderMuteSource: 'Mute this source',
    recorderFinalizationSafe: 'A safe recording was saved immediately; MP4 is being prepared in the background.',
    fileActions: 'File actions',
    downloadToDesktop: 'Download to Desktop',
    saveAs: 'Save As',
    downloadProgress: 'Save progress',
    fileSaved: 'File saved',
    fileSaveFailed: 'Could not save file',
    overlayInteractive: 'Interactive mode',
    overlayClickThrough: 'Click-through mode',
    overlayMonitor: 'Monitor',
    overlayModeHotkey: 'Toggle chat overlay mode',
    overlayFullscreenLimit: 'Protected games and exclusive fullscreen may block overlays; use Borderless when needed.',
    overlayModeChanged: 'Overlay mode changed',
    notifications: 'Notifications',
    fullscreen: 'Fullscreen',
    exitFullscreen: 'Exit fullscreen',
    pip: 'PiP over apps',
    roomId: 'Room ID',
    mic: 'Microphone',
    speaker: 'Speaker / Headphones',
    defaultDevice: 'Default',
    lowInternet: 'Low Internet Mode',
    lowPc: 'Low PC Mode',
    audioOnlyHint: 'Audio only is enabled. Change screen quality if you want to share the screen.',
    micPermission: 'Could not start the microphone. Allow microphone access and try again.',
    screenPermission: 'Could not start screen sharing. Choose a screen/window that supports audio if you need video sound.',
    roomOpened: 'Room opened. Voice starts automatically when friends join.',
    micAutoStart: 'Allow microphone access to start voice automatically.',
    micJoinTitle: 'Turn on microphone?',
    micJoinDesc: 'Choose whether to enable your microphone now or stay muted in the room.',
    activateMicNow: 'Enable microphone',
    stayMuted: 'Stay muted',
    historyForNewMembers: 'Show previous messages to new members',
    historySyncedToNewMember: 'Previous messages were sent to the new member.',
    cameraWillStartWithStream: 'Camera will start automatically when screen sharing starts.',
    cameraNeedsStream: 'Camera with stream works only while screen sharing is active.',
    invalidRoom: 'Enter a valid room code like MHLKO-7K9A-X2QF',
    confirmEndCall: 'Are you sure you want to end the call?',
    confirmCloseApp: 'Are you sure you want to close the app?',
    chatDisconnected: 'Chat is not connected right now.',
    fileTypes: 'You can send images, videos, audio, and files up to 1GB.',
    sendingFile: 'Sending file...',
    fileFailed: 'Could not send the file. Chat is not connected.',
    fileTooLarge: 'File is larger than the 1GB limit or cannot be sent safely.',
    fileSent: 'File sent.',
    voiceFailed: 'Could not send the voice message.',
    recordingStarted: 'Voice recording started. Press again to send.',
    recordingProblem: 'A problem happened while recording the voice message.',
    recordingDenied: 'Could not record audio. Make sure microphone access is allowed.',
    copied: 'Room code copied.',
    dataProblem: 'Could not start the local database. Restart the app.',
    chatCleared: 'This room history was deleted from this device.',
    confirmWipe: 'Do you want to delete all local data?',
    dataWiped: 'All local data deleted.',
    pipUnsupported: 'Picture in Picture is not supported on this device.',
    pipStartFirst: 'Start screen sharing first, then try PiP.',
    placeholderEmail: 'Optional',
    privateLabel: 'Private',
    mediaLabel: 'Media',
    fileLabel: 'File',
    emojiTitle: 'Emoji',
    attachTitle: 'Image/video/audio',
    voiceTitle: 'Voice message',
    ownerBadge: 'Room owner',
    me: 'Me',
    state_idle: 'Disconnected',
    state_connecting: 'Connecting',
    state_connected: 'Connected',
    state_room_ready: 'Room connected - waiting for members',
    state_peer_connecting: 'Connecting members',
    state_reconnecting: 'Reconnecting',
    state_disconnected: 'Disconnected',
    state_failed: 'Failed',
    typingOne: 'is typing...',
    typingMany: 'are typing...',
    error_bad_signal: 'Received an invalid signaling message.',
    error_signaling: 'Could not connect to signaling. Check your internet.',
    error_prepare_connection: 'Could not prepare the connection. Try again.',
    error_repair_connection: 'Could not repair the connection automatically. Try leaving and joining again.',
    error_data_channel: 'There is a problem with the chat channel.',
    error_bad_chat: 'Received an invalid chat message.',
    error_incomplete_file: 'The file arrived incomplete because of weak network.',
    minimizeTitle: 'Minimize to taskbar',
    maximizeTitle: 'Maximize/restore',
    trayTitle: 'Hide to system tray',
    deletedMessage: 'Message deleted',
    deleteMessage: 'Delete',
    confirmDeleteMessage: 'Delete this message?',
    sendQueued: 'Send selected images/files',
    pasteImage: 'Image added to send.',
    openImage: 'Open image',
    download: 'Download',
    log_info: 'Info',
    log_error: 'Error',
    privateP2PRoom: 'Private P2P Room',
    chatOverlayEmpty: 'Chat overlay',
    videoPreview: 'Video preview',
    dropFilesHere: 'Drop files here to add them to the send queue',
    attachmentQueued: 'File added to send queue.',
    bannedMembers: 'Banned members',
    unban: 'Allow return',
    noBannedMembers: 'No banned members.',
    settingsPanel: 'Settings',
    openSettings: 'Open settings',
    closeSettings: 'Close settings',
    screenAudioLimit: 'Note: excluding one app from full system audio needs OS/audio-driver support. Stream audio and call audio are separated inside the app as much as WebRTC allows.',
    closeTitle: 'Close',
    state_waiting_approval: 'Waiting for admin approval',
    joinRequests: 'Join requests',
    noJoinRequests: 'No requests right now.',
    approve: 'Approve',
    reject: 'Reject',
    joinAccepted: 'Join request approved.',
    joinRejected: 'Join request rejected.',
    promoteModerator: 'Make moderator',
    moderatorBadge: 'Moderator',
    promotedMember: 'Moderator role granted.',
    settingsButton: 'Settings',
    adminBadge: 'Admin',
    hotkeys: 'Hotkeys',
    errorLog: 'Event log',
    noErrors: 'No errors recorded.',
    clearLog: 'Clear log',
    close: 'Close',
    pressHotkey: 'Press the shortcut now',
    clearHotkey: 'Clear shortcut',
    hotkeySaved: 'Hotkey saved and activated.',
    hotkeyDuplicate: 'This hotkey is already assigned',
    muteMicHotkey: 'Mute/unmute mic',
    shareScreenHotkey: 'Start/stop screen share',
    endCallHotkey: 'End call',
    fullscreenHotkey: 'Fullscreen/restore stream',
    toggleSettingsHotkey: 'Open/close settings',
    holdVoiceHint: 'Hold to record, release to preview, then press Send.',
    voicePreview: 'Voice message ready to send',
    discardVoice: 'Delete recording',
    streamVolume: 'Stream sound',
    playScreenOn: 'Screen share started',
    playScreenOff: 'Screen share stopped',
    userJoined: 'A member joined',
    messageSending: 'Sending...',
    messageSent: 'Sent',
    messageDelivered: 'Delivered',
    messageSeen: 'Seen',
    troubleshootConnection: 'Troubleshoot connection',
    waitingApprovalTitle: 'Waiting for admin approval',
    waitingApprovalDesc: 'Your join request was sent. Stay here until an admin approves it.',
    restartConnectionStarted: 'Connection restarted without clearing messages.',
    restartWatchedStream: 'Restart stream',
    watchedStreamRestarted: 'Stream path is being restarted without leaving the room.',
    nativeVoiceEngine: 'Native Voice Engine',
    nativeVoiceEngineGroundwork: '0.8.5: Call audio runs in the isolated MHTalkVoice engine and is excluded from system broadcast audio.',
    echoGuardActive: 'Native echo guard is active: system-audio screen sharing excludes call audio without muting call members.',
    updateBootChecking: 'Checking for updates before opening the app...',
    updateAutoInstalling: 'A new update is available. Updating automatically...',
    checkUpdates: 'Check for updates',
    checkingUpdates: 'Checking for updates...',
    updateNone: 'No update available.',
    updateAvailable: 'Update available',
    updateInstall: 'Update now',
    updateInstalling: 'Downloading and installing update...',
    updateReady: 'Update installed. MHTalk will restart.',
    updateFailed: 'Update failed. Check GitHub Releases and latest.json setup.',
    updateTimeout: 'Update check timed out, continuing offline.',
    updateRetry: 'Retry',
    continueOffline: 'Continue Offline',
    updateProgress: 'Update progress',
    updateRequiredTitle: 'Required update available',
    updateRequiredDesc: 'You must update MHTalk before continuing. Press Update now and it will download, install, and restart automatically.',
    voiceSolutionsTitle: 'Native voice repair solutions',
    voiceSolutionsHint: 'Try Solution 1, then 2, then 3, then 4 during a call or mic test, then keep the best one for your device.',
    voiceSolutionApplied: 'Voice solution applied',
    voiceSolutionFailed: 'Could not apply voice solution',
    voiceEnhanceOn: 'Voice Enhance',
    voiceEnhanceOff: 'Turn off Voice Enhance',
    voiceEnhanceEnabled: 'Voice Enhance enabled',
    voiceEnhanceDisabled: 'Voice Enhance off',
    voiceEnhanceHint: 'Enables native voice boost, clarity, compressor and limiter for member audio. Turn it off if a device has trouble; the base Native voice path stays unchanged.',
    micTest: 'Mic test',
    micTestStart: 'Start mic test',
    micTestStop: 'Stop mic test',
    micTestHint: 'You will hear your mic through the selected speaker. Headphones are recommended to avoid echo.',
    micTestFailed: 'Could not start mic test. Check mic permission and selected device.',
    micLevel: 'Mic level',
    closeStream: 'Close stream',
    downloadLog: 'Download TXT log',
    logDownloaded: 'Event log downloaded.',
    streamStarted: 'Screen stream started.',
    streamEnded: 'Screen stream ended.',
    liveBadge: 'LIVE',
    openFile: 'Open file',
    status_sending: 'Sending',
    status_receiving: 'Receiving',
    status_completed: 'Completed',
    status_failed: 'Failed',
    status_canceled: 'Canceled',
    youtubeVideo: 'YouTube video',
    originalMessageMissing: 'Original message is not in this history.',
    openStream: 'Open Stream',
    switchStream: 'Switch Stream',
    watchingStream: 'Watching',
    streamStopped: 'Stream stopped',
    muteAllMembers: 'Mute All Members',
    unmuteAllMembers: 'Unmute All Members',
    raiseHand: 'Raise Hand',
    requestToSpeak: 'Request to speak',
    requestedPermissionToSpeak: 'Requested permission to speak',
    allowToSpeak: 'Allow to speak',
    rejectSpeakRequest: 'Reject request',
    speakRequestCooldown: 'You can request permission every 15 seconds',
    adminAllowedSpeak: 'Admin allowed member to speak',
    adminRejectedSpeak: 'Admin rejected the speak request',
    clearVoicePriority: 'Clear Voice Priority',
    mutedByAdmin: 'Muted by admin',
    memberMutedByAdmin: 'Muted by admin',
    muteForEveryone: 'Mute for everyone',
    unmuteForEveryone: 'Unmute for everyone',
    showChatOverlay: 'Show Chat Overlay',
    hideChatOverlay: 'Hide Chat Overlay',
    voiceAutoQuality: 'Voice Auto Quality',
    streamAutoQuality: 'Stream Auto Quality',
    networkWeakAdapting: 'Network weak, adapting quality',
    streamQualityLimitedNetwork: 'Stream quality limited by network',
    streamQualityLimitedDevice: 'Stream quality limited by device',
    streamViewerClosed: 'Stream viewer panel closed',
    streamViewerOpened: 'Stream viewer panel opened',
    voiceProfileChanged: 'Voice profile changed',
    adminMutedAll: 'Admin muted all members',
    chatOverlayShown: 'Chat overlay shown',
    chatOverlayHidden: 'Chat overlay hidden',
    waitingForMembers: 'Waiting for members',
    roomReady: 'Room ready',
    autoMaxQuality: 'Auto Max for your display and network',
    audioOnly: 'Audio only',
    chatOverlayCustomize: 'Customize Chat Overlay',
    overlayEditorTitle: 'Chat Overlay Editor',
    overlayEditorHint: 'This area simulates your screen. Drag and resize the overlay box and tune its appearance.',
    overlayOpacity: 'Overlay opacity',
    overlayBorderRadius: 'Overlay corners',
    overlayShowText: 'Show text messages',
    overlayShowImages: 'Show images and media',
    overlayShowAudio: 'Show voice/audio messages',
    overlayReset: 'Reset overlay',
    camera: 'Camera',
    cameraSource: 'Camera source',
    cameraToggle: 'Toggle camera',
    cameraUnavailable: 'Camera is unavailable or permission was denied.',
    cameraMirror: 'Mirror camera preview',
    cameraOverlayHint: 'Drag and resize the camera window inside the stream.',
    voicePriorityMax: 'Maximum Voice Priority',
    voicePriorityMaxHint: 'Under pressure, stream, camera, and overlay load are reduced before voice is affected.',
    cameraSettings: 'Camera Settings',
    cameraModeTitle: 'Choose camera mode',
    cameraModeHint: 'Choose whether to show camera alone in the stream area or together with screen sharing.',
    cameraWithStream: 'Camera with stream',
    cameraOnlyMode: 'Camera only',
    cameraModeBack: 'Back',
    cameraOverlayCustomize: 'Customize Camera Position',
    cameraFitMode: 'Camera framing',
    cameraFitCover: 'Fill frame with crop',
    cameraFitContain: 'Show full camera',
    cameraCropX: 'Horizontal crop focus',
    cameraCropY: 'Vertical crop focus',
    cameraOpacity: 'Camera opacity',
    cameraEditorTitle: 'Camera Box Editor',
    cameraEditorHint: 'Place and resize the camera box inside the stream area.',
    cameraStart: 'Start Camera',
    cameraStop: 'Stop Camera',
    cameraOnly: 'Camera only',
    viewCamera: 'Watch camera',
    viewStream: 'Watch stream',
    viewStreamOrCamera: 'Choose what to watch',
    overlayPersisted: 'Overlay customization saved.',
    attachmentReady: 'File is ready. Press Enter or Send to upload.',
    attachmentRejected: 'This file cannot be sent.',
    mediaCheckPassed: 'Quick file check passed.',
    logInfo: 'Info',
    mediaDownloadToDesktop: 'Download to Desktop',
    mediaCopy: 'Copy',
    mediaSavedToDesktop: 'Media saved to Desktop.',
    mediaCopied: 'Media copied.',
    mediaCopyFailed: 'Could not copy media.',
    mediaDownloadFailed: 'Could not download media.',
    previewMyMedia: 'Preview my stream/camera',
    myMediaPreview: 'My stream and camera preview',
    myScreenPreview: 'Screen stream preview',
    myCameraPreview: 'Camera preview',
    myAudioPreview: 'Audio test',
    noSelfMediaPreview: 'Start screen sharing or camera to show the preview.',
    localScreenPreviewHint: 'This is a local preview of the current screen stream.',
    videoAttachment: 'Video',
    openVideo: 'Play video',
    mediaContextTitle: 'Media options',
    friendFallback: 'Friend',
    typingSeparator: ' and ',
  },
  tr: {
    boot: 'MHTalk başlatılıyor...',
    connection: 'Arama',
    startRoom: 'Özel oda başlat',
    startRoomDesc: 'Bir oda oluşturup kodu arkadaşına gönder veya gelen oda kodunu gir. Katıldıktan sonra mikrofonu açmayı ya da sessiz kalmayı seç.',
    createRoom: 'Oda oluştur',
    joinRoom: 'Odaya katıl',
    waiting: 'Arkadaşlar bekleniyor...',
    choosePeer: 'Ekran yayınını görmek için üstteki dairelerden bir arkadaş seç',
    copyCode: 'Kodu kopyala',
    endCall: 'Aramayı bitir',
    stopVoice: 'Sesi durdur',
    startVoice: 'Sesi başlat',
    muteMic: 'Mikrofonu kapat',
    unmuteMic: 'Mikrofonu aç',
    stopShare: 'Ekran paylaşımını durdur',
    shareScreen: 'Ekran paylaş',
    refreshAudio: 'Ses aygıtlarını yenile',
    screenQuality: 'Ekran kalitesi',
    screenFps: 'FPS',
    applySettings: 'Kaydet / Uygula',
    settingsSaved: 'Ayarlar kaydedildi.',
    unsavedSettings: 'Kaydedilmemiş değişiklikler',
    saveChat: 'Sohbetleri yerel olarak kaydet',
    friendsInRoom: 'Odadaki kişiler',
    nobody: 'Henüz kimse bağlı değil.',
    showStream: 'Yayını göster',
    privateMessage: 'Özel mesaj',
    kickMember: 'Odadan at',
    kickConfirm: 'Do you want to kick this member from the room?',
    kickedOut: 'You were kicked from the room.',
    kickedMember: 'Member was kicked from the room.',
    ownerOnly: 'Only the room owner can use this option.',
    callVolume: 'Arama sesi',
    screenVolume: 'Ekran sesi',
    muteCall: 'Arama sesini kapat',
    unmuteCall: 'Arama sesini aç',
    muteScreen: 'Yayın sesini kapat',
    unmuteScreen: 'Yayın sesini aç',
    deleteRoomHistory: 'Oda geçmişini sil',
    deleteAllLocalData: 'Tüm yerel verileri sil',
    reply: 'Yanıtla',
    edit: 'Düzenle',
    edited: 'Edited',
    saveEdit: 'Düzenlemeyi kaydet',
    cancel: 'İptal',
    send: 'Gönder',
    writeMessage: 'Mesaj yaz...',
    privateTo: 'Private message to',
    replyTo: 'Yanıtlanan',
    editingMessage: 'Mesaj düzenleniyor',
    profileSettings: 'Hesap ayarları',
    localAccount: 'Edit local account',
    name: 'Ad',
    email: 'E-posta / hesap',
    status: 'Durum',
    bio: 'Hakkında',
    avatar: 'Profil resmi',
    profileImageTooLarge: 'Profil görselleri 32MB boyutundan küçük olmalıdır.',
    banner: 'Kapak resmi',
    language: 'Dil',
    screenRecorder: 'Ekran Kaydedici',
    screenRecorderTitle: 'Ekran ve Yayın Kaydedici',
    screenRecorderHint: 'Mevcut ekran yayınını hafif ve uyarlanabilir ayarlarla doğrudan cihazınıza kaydedin.',
    screenRecorderIdle: 'Kayda hazır',
    screenRecorderStarting: 'Kayıt başlatılıyor…',
    screenRecorderRecording: 'Kaydediliyor',
    screenRecorderPaused: 'Kayıt duraklatıldı',
    screenRecorderStopping: 'Kayıt kaydediliyor…',
    screenRecorderError: 'Kayıt hatası',
    screenRecorderQuality: 'Kayıt kalitesi',
    screenRecorderQualityAdaptive: 'Cihaza uyarlanmış',
    screenRecorderQualityHigh: 'Yüksek kalite',
    screenRecorderQualityBalanced: 'Dengeli',
    screenRecorderQualityPerformance: 'Performans tasarrufu',
    screenRecorderFps: 'Kayıt kare hızı',
    screenRecorderFpsMatch: 'Yayınla eşleştir',
    screenRecorderCodec: 'Video kodlayıcı',
    screenRecorderCodecAuto: 'Otomatik (önerilen)',
    screenRecorderIncludeAudio: 'Yayın sesini kaydet',
    screenRecorderAutoStart: 'Ekran paylaşımıyla otomatik başlat',
    screenRecorderSource: 'Yayın kaynağı',
    screenRecorderSourceUnavailable: 'Ekran paylaşımını başlatın',
    screenRecorderEstimatedSize: 'Tahmini boyut',
    screenRecorderAdaptiveEstimate: 'Başlatılınca hesaplanır',
    screenRecorderStart: 'Kaydı başlat',
    screenRecorderPause: 'Duraklat',
    screenRecorderResume: 'Devam et',
    screenRecorderStop: 'Durdur ve kaydet',
    screenRecorderOpenFolder: 'Kayıtlar klasörünü aç',
    screenRecorderSaveSettings: 'Ayarları kaydet',
    screenRecorderSettingsSaved: 'Ekran kaydedici ayarları kaydedildi.',
    screenRecorderNeedsStream: 'Yayını kaydetmeden önce ekran paylaşımını başlatın.',
    screenRecorderSaved: 'Kayıt kaydedildi',
    screenRecorderSaveFailed: 'Yayın kaydedilemedi veya saklanamadı',
    screenRecorderLocalOnly: 'Yalnızca yerel olarak kaydedilir',
    screenRecorderAudioUnavailable: 'Mevcut yayında ses parçası yok; video sessiz kaydedilecek.',
    screenRecorderFile: 'Kayıt dosyası',
    screenRecorderPerformanceNote: 'Kaydedici ikinci bir yakalama başlatmadan mevcut ekran akışını kullanır ve cihaz yükünü azaltmak için kare hızını ve bit hızını uyarlar.',
    screenRecorderSettingsOnly: 'Bu pencere yalnızca kayıt ayarları içindir. Kaydı Ekran Paylaşımı düğmesinin yanındaki düğmeden başlatın veya durdurun.',
    screenRecorderToolbarStart: 'Yayın kaydını başlat',
    screenRecorderToolbarStop: 'Kaydı durdur ve MP4 kaydet',
    screenRecorderArmed: 'Ekran paylaşımı ve kayıt başlatılıyor…',
    screenRecorderMp4Hint: 'Kayıt veya ekran paylaşımı durduğunda önce yakalama kapanır, ardından otomatik olarak MP4 biçimine dönüştürülür.',
    screenRecorderRepair: 'Kesilen kaydı onar',
    screenRecorderRepairTitle: 'Eksik kaydı kurtar',
    screenRecorderRepairHint: 'Önceki kayda yeni ve güvenli bir bölümde devam edin veya durdurup kaydedilmiş bölümleri MP4 dosyasına onarın.',
    screenRecorderNoRecovery: 'Onarılması gereken eksik kayıt yok.',
    screenRecorderResumePrevious: 'Önceki kayda devam et',
    screenRecorderStopAndSaveMp4: 'Durdur ve MP4 kaydet',
    screenRecorderRecoveryDate: 'Son kayıt',
    screenRecorderRecoverySize: 'Kaydedilen boyut',
    screenRecorderRecoverySegments: 'bölüm',
    screenRecorderRecoveryStarted: 'Önceki kayda devam ediliyor.',
    screenRecorderRecoverySaved: 'Kayıt onarıldı ve MP4 olarak kaydedildi',
    screenRecorderRepairFailed: 'Kayıt onarılamadı',
    screenRecorderFinalizingMp4: 'MP4 hazırlanıyor…',
    screenRecorderDependencyPreparing: 'MP4 dönüştürücü sizi rahatsız etmeden arka planda hazırlanıyor.',
    screenRecorderDependencyReady: 'MP4 dönüştürücü hazır.',
    screenRecorderDependencyFailed: 'MP4 dönüştürücü otomatik olarak hazırlanamadı.',
    recorderMyMic: 'Mikrofonum',
    recorderMembers: 'Diğer üyelerin sesleri',
    recorderSystem: 'Sistem / oyun sesi',
    recorderAutoDuck: 'Konuşma sırasında sistem sesini otomatik azalt',
    recorderMicDevice: 'Kayıt mikrofonu',
    recorderOutputDevice: 'Üye sesleri çıkışı',
    recorderMasterMeter: 'Son karışım seviyesi',
    recorderMuteSource: 'Bu kaynağı sessize al',
    recorderFinalizationSafe: 'Güvenli kayıt hemen kaydedildi; MP4 arka planda hazırlanıyor.',
    fileActions: 'Dosya seçenekleri',
    downloadToDesktop: 'Masaüstüne indir',
    saveAs: 'Farklı kaydet',
    downloadProgress: 'Kaydetme ilerlemesi',
    fileSaved: 'Dosya kaydedildi',
    fileSaveFailed: 'Dosya kaydedilemedi',
    overlayInteractive: 'Etkileşimli mod',
    overlayClickThrough: 'Tıklamaları geçiren mod',
    overlayMonitor: 'Monitör',
    overlayModeHotkey: 'Sohbet kaplaması modunu değiştir',
    overlayFullscreenLimit: 'Korumalı oyunlar ve özel tam ekran kaplamayı engelleyebilir; gerektiğinde Kenarlıksız kullanın.',
    overlayModeChanged: 'Kaplama modu değiştirildi',
    notifications: 'Bildirimler',
    fullscreen: 'Tam ekran',
    exitFullscreen: 'Tam ekrandan çık',
    pip: 'PiP over apps',
    roomId: 'Oda kodu',
    mic: 'Mikrofon',
    speaker: 'Hoparlör / Kulaklık',
    defaultDevice: 'Varsayılan',
    lowInternet: 'Zayıf internet modu',
    lowPc: 'Zayıf bilgisayar modu',
    audioOnlyHint: 'Audio only is enabled. Change screen quality if you want to share the screen.',
    micPermission: 'Could not start the microphone. Allow microphone access and try again.',
    screenPermission: 'Could not start screen sharing. Choose a screen/window that supports audio if you need video sound.',
    roomOpened: 'Room opened. Voice starts automatically when friends join.',
    micAutoStart: 'Allow microphone access to start voice automatically.',
    micJoinTitle: 'Turn on microphone?',
    micJoinDesc: 'Choose whether to enable your microphone now or stay muted in the room.',
    activateMicNow: 'Enable microphone',
    stayMuted: 'Stay muted',
    historyForNewMembers: 'Yeni üyeler önceki mesajları görsün',
    historySyncedToNewMember: 'Previous messages were sent to the new member.',
    cameraWillStartWithStream: 'Camera will start automatically when screen sharing starts.',
    cameraNeedsStream: 'Camera with stream works only while screen sharing is active.',
    invalidRoom: 'Enter a valid room code like MHLKO-7K9A-X2QF',
    confirmEndCall: 'Are you sure you want to end the call?',
    confirmCloseApp: 'Are you sure you want to close the app?',
    chatDisconnected: 'Chat is not connected right now.',
    fileTypes: 'You can send images, videos, audio, and files up to 1GB.',
    sendingFile: 'Sending file...',
    fileFailed: 'Could not send the file. Chat is not connected.',
    fileTooLarge: 'File is larger than the 1GB limit or cannot be sent safely.',
    fileSent: 'File sent.',
    voiceFailed: 'Could not send the voice message.',
    recordingStarted: 'Voice recording started. Press again to send.',
    recordingProblem: 'A problem happened while recording the voice message.',
    recordingDenied: 'Could not record audio. Make sure microphone access is allowed.',
    copied: 'Room code copied.',
    dataProblem: 'Could not start the local database. Restart the app.',
    chatCleared: 'This room history was deleted from this device.',
    confirmWipe: 'Do you want to delete all local data?',
    dataWiped: 'All local data deleted.',
    pipUnsupported: 'Picture in Picture is not supported on this device.',
    pipStartFirst: 'Start screen sharing first, then try PiP.',
    placeholderEmail: 'Optional',
    privateLabel: 'Private',
    mediaLabel: 'Media',
    fileLabel: 'File',
    emojiTitle: 'Emoji',
    attachTitle: 'Resim/video/ses',
    voiceTitle: 'Sesli mesaj',
    ownerBadge: 'Room owner',
    me: 'Me',
    state_idle: 'Disconnected',
    state_connecting: 'Connecting',
    state_connected: 'Connected',
    state_room_ready: 'Room connected - waiting for members',
    state_peer_connecting: 'Connecting members',
    state_reconnecting: 'Reconnecting',
    state_disconnected: 'Disconnected',
    state_failed: 'Failed',
    typingOne: 'is typing...',
    typingMany: 'are typing...',
    error_bad_signal: 'Received an invalid signaling message.',
    error_signaling: 'Could not connect to signaling. Check your internet.',
    error_prepare_connection: 'Could not prepare the connection. Try again.',
    error_repair_connection: 'Could not repair the connection automatically. Try leaving and joining again.',
    error_data_channel: 'There is a problem with the chat channel.',
    error_bad_chat: 'Received an invalid chat message.',
    error_incomplete_file: 'The file arrived incomplete because of weak network.',
    minimizeTitle: 'Minimize to taskbar',
    maximizeTitle: 'Maximize/restore',
    trayTitle: 'Hide to system tray',
    deletedMessage: 'Message deleted',
    deleteMessage: 'Sil',
    confirmDeleteMessage: 'Delete this message?',
    sendQueued: 'Send selected images/files',
    pasteImage: 'Image added to send.',
    openImage: 'Open image',
    download: 'Download',
    log_info: 'Info',
    log_error: 'Error',
    privateP2PRoom: 'Özel P2P Odası',
    chatOverlayEmpty: 'Sohbet kaplaması',
    videoPreview: 'Video preview',
    dropFilesHere: 'Drop files here to add them to the send queue',
    attachmentQueued: 'File added to send queue.',
    bannedMembers: 'Yasaklanan üyeler',
    unban: 'Allow return',
    noBannedMembers: 'No banned members.',
    settingsPanel: 'Ayarlar',
    openSettings: 'Ayarları aç',
    closeSettings: 'Ayarları kapat',
    screenAudioLimit: 'Note: excluding one app from full system audio needs OS/audio-driver support. Stream audio and call audio are separated inside the app as much as WebRTC allows.',
    closeTitle: 'Çıkış',
    state_waiting_approval: 'Waiting for admin approval',
    joinRequests: 'Join requests',
    noJoinRequests: 'No requests right now.',
    approve: 'Onayla',
    reject: 'Reddet',
    joinAccepted: 'Join request approved.',
    joinRejected: 'Join request rejected.',
    promoteModerator: 'Make moderator',
    moderatorBadge: 'Moderator',
    promotedMember: 'Moderator role granted.',
    settingsButton: 'Settings',
    adminBadge: 'Admin',
    hotkeys: 'Kısayollar',
    errorLog: 'Olay günlüğü',
    noErrors: 'Kayıtlı hata yok.',
    clearLog: 'Günlüğü temizle',
    close: 'Kapat',
    pressHotkey: 'Kısayola şimdi bas',
    clearHotkey: 'Kısayolu temizle',
    hotkeySaved: 'Kısayol kaydedildi ve etkinleştirildi.',
    hotkeyDuplicate: 'Bu kısayol zaten kullanılıyor',
    muteMicHotkey: 'Mute/unmute mic',
    shareScreenHotkey: 'Start/stop screen share',
    endCallHotkey: 'End call',
    fullscreenHotkey: 'Fullscreen/restore stream',
    toggleSettingsHotkey: 'Open/close settings',
    holdVoiceHint: 'Kaydetmek için basılı tut, önizleme için bırak, sonra Gönder’e bas.',
    voicePreview: 'Sesli mesaj gönderime hazır',
    discardVoice: 'Kaydı sil',
    streamVolume: 'Yayın sesi',
    playScreenOn: 'Ekran paylaşımı başladı',
    playScreenOff: 'Ekran paylaşımı durdu',
    userJoined: 'A member joined',
    messageSending: 'Sending...',
    messageSent: 'Sent',
    messageDelivered: 'Delivered',
    messageSeen: 'Seen',
    troubleshootConnection: 'Troubleshoot connection',
    waitingApprovalTitle: 'Yönetici onayı bekleniyor',
    waitingApprovalDesc: 'Katılma isteğin gönderildi. Yönetici onaylayana kadar bekle.',
    restartConnectionStarted: 'Connection restarted without clearing messages.',
    restartWatchedStream: 'Yayını yeniden başlat',
    watchedStreamRestarted: 'Yayın yolu odadan çıkmadan yeniden başlatılıyor.',
    nativeVoiceEngine: 'Native Ses Motoru',
    nativeVoiceEngineGroundwork: '0.8.5: Arama sesi ayrı MHTalkVoice motorunda çalışır ve sistem yayın sesinden tamamen hariç tutulur.',
    echoGuardActive: 'Yankı koruması aktif: sistem sesi paylaşımı, arama üyelerini susturmadan arama sesini dışarıda bırakır.',
    updateBootChecking: 'Checking for updates before opening the app...',
    updateAutoInstalling: 'A new update is available. Updating automatically...',
    checkUpdates: 'Güncellemeleri kontrol et',
    checkingUpdates: 'Checking for updates...',
    updateNone: 'No update available.',
    updateAvailable: 'Update available',
    updateInstall: 'Şimdi güncelle',
    updateInstalling: 'Downloading and installing update...',
    updateReady: 'Update installed. MHTalk will restart.',
    updateFailed: 'Update failed. Check GitHub Releases and latest.json setup.',
    updateTimeout: 'Update check timed out, continuing offline.',
    updateRetry: 'Retry',
    continueOffline: 'Continue Offline',
    updateProgress: 'Update progress',
    updateRequiredTitle: 'Required update available',
    updateRequiredDesc: 'You must update MHTalk before continuing. Press Update now and it will download, install, and restart automatically.',
    voiceSolutionsTitle: 'Native voice repair solutions',
    voiceSolutionsHint: 'Try Solution 1, then 2, then 3, then 4 during a call or mic test, then keep the best one for your device.',
    voiceSolutionApplied: 'Voice solution applied',
    voiceSolutionFailed: 'Could not apply voice solution',
    voiceEnhanceOn: 'Voice Enhance',
    voiceEnhanceOff: 'Voice Enhance kapat',
    voiceEnhanceEnabled: 'Voice Enhance açık',
    voiceEnhanceDisabled: 'Voice Enhance kapalı',
    voiceEnhanceHint: 'Enables native voice boost, clarity, compressor and limiter for member audio. Turn it off if a device has trouble; the base Native voice path stays unchanged.',
    micTest: 'Mikrofon testi',
    micTestStart: 'Mikrofon testini başlat',
    micTestStop: 'Mikrofon testini durdur',
    micTestHint: 'Mikrofonunu seçilen hoparlörden duyacaksın. Yankı olmaması için kulaklık önerilir.',
    micTestFailed: 'Mikrofon testi başlatılamadı. İzinleri ve aygıtı kontrol et.',
    micLevel: 'Mikrofon seviyesi',
    closeStream: 'Yayını kapat',
    downloadLog: 'TXT günlüğünü indir',
    logDownloaded: 'Event log downloaded.',
    streamStarted: 'Screen stream started.',
    streamEnded: 'Screen stream ended.',
    liveBadge: 'LIVE',
    openFile: 'Open file',
    status_sending: 'Sending',
    status_receiving: 'Receiving',
    status_completed: 'Completed',
    status_failed: 'Failed',
    status_canceled: 'Canceled',
    youtubeVideo: 'YouTube video',
    originalMessageMissing: 'Original message is not in this history.',
    openStream: 'Open Stream',
    switchStream: 'Switch Stream',
    watchingStream: 'Watching',
    streamStopped: 'Stream stopped',
    muteAllMembers: 'Mute All Members',
    unmuteAllMembers: 'Unmute All Members',
    raiseHand: 'Raise Hand',
    requestToSpeak: 'Request to speak',
    requestedPermissionToSpeak: 'Requested permission to speak',
    allowToSpeak: 'Allow to speak',
    rejectSpeakRequest: 'Reject request',
    speakRequestCooldown: 'You can request permission every 15 seconds',
    adminAllowedSpeak: 'Admin allowed member to speak',
    adminRejectedSpeak: 'Admin rejected the speak request',
    clearVoicePriority: 'Clear Voice Priority',
    mutedByAdmin: 'Muted by admin',
    memberMutedByAdmin: 'Muted by admin',
    muteForEveryone: 'Mute for everyone',
    unmuteForEveryone: 'Unmute for everyone',
    showChatOverlay: 'Show Chat Overlay',
    hideChatOverlay: 'Hide Chat Overlay',
    voiceAutoQuality: 'Voice Auto Quality',
    streamAutoQuality: 'Stream Auto Quality',
    networkWeakAdapting: 'Network weak, adapting quality',
    streamQualityLimitedNetwork: 'Stream quality limited by network',
    streamQualityLimitedDevice: 'Stream quality limited by device',
    streamViewerClosed: 'Stream viewer panel closed',
    streamViewerOpened: 'Stream viewer panel opened',
    voiceProfileChanged: 'Voice profile changed',
    adminMutedAll: 'Admin muted all members',
    chatOverlayShown: 'Chat overlay shown',
    chatOverlayHidden: 'Chat overlay hidden',
    waitingForMembers: 'Waiting for members',
    roomReady: 'Room ready',
    autoMaxQuality: 'Auto Max for your display and network',
    audioOnly: 'Audio only',
    chatOverlayCustomize: 'Sohbet kaplamasını özelleştir',
    overlayEditorTitle: 'Sohbet kaplaması düzenleyici',
    overlayEditorHint: 'Bu alan ekranını simüle eder. Kaplama kutusunu sürükle, boyutlandır ve görünümünü ayarla.',
    overlayOpacity: 'Kaplama saydamlığı',
    overlayBorderRadius: 'Kaplama köşeleri',
    overlayShowText: 'Metin mesajlarını göster',
    overlayShowImages: 'Görselleri ve medyayı göster',
    overlayShowAudio: 'Sesli mesajları göster',
    overlayReset: 'Kaplamayı sıfırla',
    camera: 'Kamera',
    cameraSource: 'Kamera kaynağı',
    cameraToggle: 'Toggle camera',
    cameraUnavailable: 'Camera is unavailable or permission was denied.',
    cameraMirror: 'Kamera önizlemesini aynala',
    cameraOverlayHint: 'Drag and resize the camera window inside the stream.',
    voicePriorityMax: 'Maximum Voice Priority',
    voicePriorityMaxHint: 'Under pressure, stream, camera, and overlay load are reduced before voice is affected.',
    cameraSettings: 'Kamera ayarları',
    cameraModeTitle: 'Kamera modu seç',
    cameraModeHint: 'Kamerayı tek başına mı yoksa ekran paylaşımıyla birlikte mi göstereceğini seç.',
    cameraWithStream: 'Yayınla birlikte kamera',
    cameraOnlyMode: 'Sadece kamera',
    cameraModeBack: 'Back',
    cameraOverlayCustomize: 'Kamera konumunu özelleştir',
    cameraFitMode: 'Kamera çerçevesi',
    cameraFitCover: 'Kırparak çerçeveyi doldur',
    cameraFitContain: 'Kameranın tamamını göster',
    cameraCropX: 'Yatay kırpma odağı',
    cameraCropY: 'Dikey kırpma odağı',
    cameraOpacity: 'Kamera saydamlığı',
    cameraEditorTitle: 'Kamera kutusu düzenleyici',
    cameraEditorHint: 'Kamera kutusunu yayın alanına yerleştir ve boyutlandır.',
    cameraStart: 'Kamerayı başlat',
    cameraStop: 'Kamerayı durdur',
    cameraOnly: 'Sadece kamera',
    viewCamera: 'Watch camera',
    viewStream: 'Watch stream',
    viewStreamOrCamera: 'Choose what to watch',
    overlayPersisted: 'Overlay customization saved.',
    attachmentReady: 'File is ready. Press Enter or Send to upload.',
    attachmentRejected: 'This file cannot be sent.',
    mediaCheckPassed: 'Quick file check passed.',
    logInfo: 'Info',
    mediaDownloadToDesktop: 'Masaüstüne indir',
    mediaCopy: 'Kopyala',
    mediaSavedToDesktop: 'Medya masaüstüne kaydedildi.',
    mediaCopied: 'Medya kopyalandı.',
    mediaCopyFailed: 'Medya kopyalanamadı.',
    mediaDownloadFailed: 'Medya indirilemedi.',
    previewMyMedia: 'Yayınımı/kameramı önizle',
    myMediaPreview: 'Yayın ve kamera önizlemem',
    myScreenPreview: 'Ekran yayını önizlemesi',
    myCameraPreview: 'Kamera önizlemesi',
    myAudioPreview: 'Ses testi',
    noSelfMediaPreview: 'Önizleme için yayın veya kamerayı başlat.',
    localScreenPreviewHint: 'Bu, mevcut ekran yayınının yerel önizlemesidir.',
    videoAttachment: 'Video',
    openVideo: 'Play video',
    mediaContextTitle: 'Medya seçenekleri',
    friendFallback: 'Arkadaş',
    typingSeparator: ' ve ',
  },
};

const ALL_APP_LANGUAGES: AppLanguage[] = ['ar', 'en', 'tr'];
// 0.7.6: every language pack is resolved from its own dictionary only.
// No Arabic/English inheritance is applied at runtime, so selecting a language
// can no longer silently mix another language into visible UI strings.
const TEXT: Record<AppLanguage, Record<string, string>> = Object.fromEntries(
  ALL_APP_LANGUAGES.map((language) => [language, { ...(LOCALIZED_TEXT[language] || {}) }])
) as Record<AppLanguage, Record<string, string>>;

const COMPLETE_LANGUAGES = new Set<AppLanguage>(ALL_APP_LANGUAGES);
// 0.6.8: restore all language choices and validate that every visible language has every key.
const LANGUAGE_OPTIONS: Array<{ value: AppLanguage; label: string }> = [
  { value: 'ar', label: 'العربية' },
  { value: 'en', label: 'English' },
  { value: 'tr', label: 'Türkçe' }
];

const RTL_LANGUAGES: AppLanguage[] = ['ar'];

type PeerVolume = { voice: number; screen: number; voiceMuted: boolean; screenMuted: boolean };
type PendingAttachment = { id: string; file: File; preview?: string };
type CameraBox = { x: number; y: number; width: number; height: number };

type MediaPreview = { src: string; name?: string; kind: 'image' | 'video'; localPath?: string };
type ImagePreview = { src: string; name?: string };
type MediaContextMenu = MediaPreview & { x: number; y: number };
type FileContextMenu = { message: ChatMessage; x: number; y: number };
type FileSaveProgress = { operationId: string; written: number; total: number; targetPath: string };
type SelfMediaMenu = { x: number; y: number };
type BannedMember = { peerId: string; displayName: string; kickedAt: number };
type JoinRequest = { peerId: string; displayName: string; requestedAt: number };
type SpeakRequest = { peerId: string; displayName: string; requestedAt: number };
type RoomRole = 'owner' | 'moderator' | 'member';
type HotkeyAction = 'muteMic' | 'toggleScreen' | 'endCall' | 'toggleFullscreen' | 'toggleSettings' | 'toggleOverlayMode';
type PendingVoiceMessage = { blob: Blob; dataUrl: string; waveform: number[] };
type LogEntry = { id: string; at: number; level: 'error' | 'info'; message: string };
type VoiceEngineStatus = { supported: boolean; ready: boolean; phase: string; processName: string; note: string; voiceEnhanceEnabled?: boolean };

let currentVoiceMessageAudio: HTMLAudioElement | null = null;

type MediaVideoProps = { stream?: MediaStream; active: boolean; videoRef?: RefObject<HTMLVideoElement | null>; audioEnabled?: boolean; muted?: boolean; volume?: number; outputId?: string; refreshToken?: number };
function MediaVideo({ stream, active, videoRef, audioEnabled = false, muted = true, volume = 1, outputId, refreshToken = 0 }: MediaVideoProps) {
  const localRef = useRef<HTMLVideoElement | null>(null);
  const ref = videoRef || localRef;
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let cancelled = false;
    const bind = () => {
      if (cancelled) return;
      if (!stream || !active) {
        video.pause();
        video.muted = true;
        video.srcObject = null;
        return;
      }
      video.srcObject = stream || null;
      // Normal app playback is handled by the separate screen-audio sink.
      // Only PiP enables the video element audio so the PiP mute button actually works.
      video.muted = !audioEnabled || muted || !stream;
      video.volume = Math.min(1, Math.max(0, volume));
      const sink = video as HTMLVideoElement & { setSinkId?: (sinkId: string) => Promise<void> };
      if (sink.setSinkId && outputId) sink.setSinkId(outputId).catch(() => undefined);
      video.play().catch(() => undefined);
    };
    if (refreshToken > 0) {
      video.pause();
      video.srcObject = null;
      window.requestAnimationFrame(bind);
    } else {
      bind();
    }
    return () => { cancelled = true; };
  }, [stream, active, ref, audioEnabled, muted, volume, outputId, refreshToken]);
  useEffect(() => () => {
    const video = ref.current;
    if (!video) return;
    video.pause();
    video.srcObject = null;
  }, [ref]);
  return <video ref={ref} autoPlay playsInline className={active ? 'screen-video active' : 'screen-video'} />;
}

type AudioSinkProps = { stream?: MediaStream; muted: boolean; volume: number; outputId?: string; refreshToken?: number };

function LocalMediaPreview({ stream, className = 'self-preview-video', style }: { stream?: MediaStream | null; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream || null;
    if (stream) video.play().catch(() => undefined);
    return () => { if (video) video.srcObject = null; };
  }, [stream]);
  return <video ref={ref} className={className} style={style} autoPlay playsInline muted />;
}

function AudioSink({ stream, muted, volume, outputId, refreshToken = 0 }: AudioSinkProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const sink = audio as HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };
    let cancelled = false;

    const startPlayback = async () => {
      if (cancelled) return;
      audio.srcObject = stream || null;
      audio.volume = Math.min(1, Math.max(0, volume));
      audio.muted = muted || !stream;
      if (!stream || audio.muted) {
        audio.pause();
        return;
      }
      try {
        if (sink.setSinkId && outputId) await sink.setSinkId(outputId);
      } catch {
        // Ignore sink selection failures and fall back to default output.
      }
      try {
        await audio.play();
      } catch {
        // Browsers can reject play() until the user interacts, which is expected.
      }
    };

    if (refreshToken > 0) {
      audio.pause();
      audio.srcObject = null;
      window.requestAnimationFrame(() => startPlayback().catch(() => undefined));
    } else {
      startPlayback().catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [stream, muted, volume, outputId, refreshToken]);
  useEffect(() => () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.srcObject = null;
  }, []);
  return <audio ref={audioRef} autoPlay playsInline />;
}

function BoostedAudioSink({ stream, muted, volume, outputId, refreshToken = 0 }: AudioSinkProps) {
  const ctxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const destinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const [boostedStream, setBoostedStream] = useState<MediaStream | undefined>(undefined);
  const shouldBoost = Boolean(stream?.getAudioTracks().length) && volume > 1;

  useEffect(() => {
    try { sourceRef.current?.disconnect(); } catch { /* ignore */ }
    sourceRef.current = null;
    setBoostedStream(undefined);
    if (!stream || !stream.getAudioTracks().length || !shouldBoost) return;
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = ctxRef.current || new AudioContextClass();
    const gain = gainRef.current || ctx.createGain();
    const destination = destinationRef.current || ctx.createMediaStreamDestination();
    ctxRef.current = ctx;
    gainRef.current = gain;
    destinationRef.current = destination;
    gain.gain.value = muted ? 0 : Math.min(2, Math.max(0, volume));
    try { ctx.resume().catch(() => undefined); } catch { /* ignore */ }
    try {
      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;
      source.connect(gain);
      gain.connect(destination);
      setBoostedStream(destination.stream);
      return () => {
        try { source.disconnect(); } catch { /* ignore */ }
        try { gain.disconnect(destination); } catch { /* ignore */ }
      };
    } catch {
      return;
    }
  }, [stream, shouldBoost, refreshToken]);

  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = muted ? 0 : Math.min(2, Math.max(0, volume));
  }, [muted, volume]);

  useEffect(() => () => {
    try { sourceRef.current?.disconnect(); } catch { /* ignore */ }
    try { gainRef.current?.disconnect(); } catch { /* ignore */ }
    sourceRef.current = null;
    gainRef.current = null;
    destinationRef.current = null;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx && ctx.state !== 'closed') ctx.close().catch(() => undefined);
  }, []);

  return <AudioSink stream={shouldBoost ? boostedStream : stream} muted={muted || (shouldBoost && !boostedStream)} volume={shouldBoost ? 1 : Math.min(1, volume)} outputId={outputId} refreshToken={refreshToken} />;
}

function SpeakingDetector({ stream, peerId, onSpeaking }: { stream?: MediaStream; peerId: string; onSpeaking: (peerId: string, active: boolean) => void }) {
  useEffect(() => {
    if (!stream?.getAudioTracks().length) {
      onSpeaking(peerId, false);
      return;
    }
    let stopped = false;
    let raf = 0;
    let activeFrames = 0;
    let inactiveFrames = 0;
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;
    analyser.minDecibels = -90;
    analyser.maxDecibels = -10;
    const data = new Float32Array(analyser.fftSize);
    let source: MediaStreamAudioSourceNode | null = null;
    try {
      source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
    } catch {
      ctx.close().catch(() => undefined);
      return;
    }
    const tick = () => {
      if (stopped) return;
      try {
        ctx.resume().catch(() => undefined);
        analyser.getFloatTimeDomainData(data);
        let sumSquares = 0;
        for (let index = 0; index < data.length; index += 1) {
          const value = data[index] || 0;
          sumSquares += value * value;
        }
        const rms = Math.sqrt(sumSquares / data.length);
        const active = rms > 0.02;
        if (active) {
          activeFrames += 1;
          inactiveFrames = 0;
          if (activeFrames >= 2) onSpeaking(peerId, true);
        } else {
          inactiveFrames += 1;
          activeFrames = 0;
          if (inactiveFrames >= 4) onSpeaking(peerId, false);
        }
      } catch {
        onSpeaking(peerId, false);
      }
      raf = window.setTimeout(tick, 120) as unknown as number;
    };
    tick();
    return () => {
      stopped = true;
      window.clearTimeout(raf);
      onSpeaking(peerId, false);
      try { source?.disconnect(); } catch { /* ignore */ }
      ctx.close().catch(() => undefined);
    };
  }, [stream, peerId, onSpeaking]);
  return null;
}

function nowId() { return `${Date.now()}-${crypto.randomUUID()}`; }

function messageKindFromMime(mimeType: string): ChatMessage['kind'] {
  return mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : 'file';
}

function normalizeHotkeyCombo(combo = ''): string {
  if (!combo) return '';
  const parts = combo.split('+').filter(Boolean);
  const last = parts.pop();
  if (!last) return '';
  const legacyMap: Record<string, string> = {
    ',': 'Comma', '.': 'Period', '/': 'Slash', ';': 'Semicolon', "'": 'Quote', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', '-': 'Minus', '=': 'Equal', '`': 'Backquote', ' ': 'Space'
  };
  let code = last;
  if (/^[A-Z]$/i.test(last)) code = `Key${last.toUpperCase()}`;
  else if (/^[0-9]$/.test(last)) code = `Digit${last}`;
  else if (legacyMap[last]) code = legacyMap[last];
  return [...parts, code].join('+');
}

function hotkeyCodeLabel(code: string): string {
  const named: Record<string, string> = {
    Space: 'Space', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', Escape: 'Esc', Enter: 'Enter', Tab: 'Tab'
  };
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return code.replace('Numpad', 'Num ');
  return named[code] || code.replace(/(Left|Right)$/, '');
}

function displayHotkey(combo = ''): string {
  const normalized = normalizeHotkeyCombo(combo);
  if (!normalized) return '?';
  const parts = normalized.split('+');
  const code = parts.pop() || '';
  return [...parts, hotkeyCodeLabel(code)].join('+');
}

function toTauriShortcut(combo = ''): string {
  const normalized = normalizeHotkeyCombo(combo);
  if (!normalized) return '';
  return normalized
    .replace(/^Ctrl(?=\+|$)/, 'CommandOrControl')
    .replace(/\+Key([A-Z])$/i, '+$1')
    .replace(/\+Digit([0-9])$/, '+$1')
    .replace(/\+Comma$/, '+Comma')
    .replace(/\+Period$/, '+Period')
    .replace(/\+Space$/, '+Space');
}

function formatHotkeyEvent(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');
  const code = event.code || event.key;
  if (!['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'Control', 'Shift', 'Alt', 'Meta'].includes(code)) parts.push(code);
  return parts.length && parts[parts.length - 1] ? parts.join('+') : '';
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return Boolean(element.closest('input, textarea, [contenteditable="true"]'));
}

function systemMessage(roomId: string, body: string): ChatMessage {
  return { id: nowId(), roomId, sender: 'system', senderName: 'MHTalk', body, createdAt: Date.now(), kind: 'text' };
}

function formatBytes(value = 0): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = Math.max(0, value);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatRecorderDuration(totalSeconds = 0): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function getScreenCapability() {
  const width = Math.max(window.screen.width || 0, window.screen.availWidth || 0);
  const height = Math.max(window.screen.height || 0, window.screen.availHeight || 0);
  const longEdge = Math.max(width, height);
  const refreshRate = Number((window.screen as Screen & { refreshRate?: number }).refreshRate || 60);
  return { width, height, longEdge, refreshRate: Number.isFinite(refreshRate) ? refreshRate : 60 };
}

function qualityOptionsForScreen(): ScreenQuality[] {
  const { longEdge } = getScreenCapability();
  const options: ScreenQuality[] = ['auto-max'];
  if (longEdge >= 3840) options.push('4k');
  if (longEdge >= 2560) options.push('1440p');
  if (longEdge >= 1920) options.push('1080p');
  if (longEdge >= 1280) options.push('720p');
  options.push('480p', '360p', 'audio-only');
  return Array.from(new Set(options));
}

function fpsOptionsForScreen(): ScreenFps[] {
  const { refreshRate } = getScreenCapability();
  const options: ScreenFps[] = [];
  if (refreshRate >= 140) options.push(144);
  if (refreshRate >= 115) options.push(120);
  options.push(60, 30, 15, 8);
  return Array.from(new Set(options));
}

function readFileAsDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return readFileAsDataUrl(blob);
}

async function mediaSourceToDataUrl(src: string): Promise<string> {
  if (src.startsWith('data:')) return src;
  const response = await fetch(src);
  const blob = await response.blob();
  return blobToDataUrl(blob);
}

function pickVoiceRecorderMimeType(): string | undefined {
  const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return preferred.find((type) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type));
}

function buildRecorderMicConstraints(inputDeviceId?: string): MediaTrackConstraints {
  const audio: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: { ideal: 1 }
  };
  if (inputDeviceId) audio.deviceId = { ideal: inputDeviceId };
  return audio;
}

function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : null;
}

function youtubeIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('youtu.be')) return parsed.pathname.replace('/', '') || null;
    if (parsed.hostname.includes('youtube.com')) return parsed.searchParams.get('v') || parsed.pathname.split('/').filter(Boolean).pop() || null;
  } catch { /* ignore */ }
  return null;
}

function linkPreviewFromText(body: string): ChatMessage['linkPreview'] | undefined {
  const url = extractFirstUrl(body);
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const yt = youtubeIdFromUrl(url);
    return {
      url,
      title: yt ? 'YouTube' : parsed.hostname.replace(/^www\./, ''),
      provider: parsed.hostname.replace(/^www\./, ''),
      image: yt ? `https://img.youtube.com/vi/${yt}/hqdefault.jpg` : undefined
    };
  } catch {
    return undefined;
  }
}



const DESKTOP_CHAT_OVERLAY_WIDTH = 420;
const DESKTOP_CHAT_OVERLAY_HEIGHT = 245;
type OverlayMessageItem = { senderName: string; body: string; kind?: string; dataUrl?: string };

function clampOverlaySettings(settings?: Partial<ChatOverlaySettings>): ChatOverlaySettings {
  const base = DEFAULT_SETTINGS.chatOverlay;
  const merged = { ...base, ...(settings || {}) };
  return {
    ...merged,
    xPercent: Math.min(95, Math.max(0, Number(merged.xPercent))),
    yPercent: Math.min(95, Math.max(0, Number(merged.yPercent))),
    widthPercent: Math.min(90, Math.max(12, Number(merged.widthPercent))),
    heightPercent: Math.min(60, Math.max(8, Number(merged.heightPercent))),
    opacity: Math.min(1, Math.max(0.15, Number(merged.opacity))),
    borderRadius: Math.min(40, Math.max(0, Number(merged.borderRadius)))
  };
}


function clampCameraSettings(settings?: Partial<CameraOverlaySettings>): CameraOverlaySettings {
  const base = DEFAULT_CAMERA_OVERLAY;
  const merged = { ...base, ...(settings || {}) };
  return {
    ...merged,
    xPercent: Math.min(95, Math.max(0, Number(merged.xPercent))),
    yPercent: Math.min(95, Math.max(0, Number(merged.yPercent))),
    widthPercent: Math.min(70, Math.max(10, Number(merged.widthPercent))),
    heightPercent: Math.min(70, Math.max(10, Number(merged.heightPercent))),
    borderRadius: Math.min(50, Math.max(0, Number(merged.borderRadius))),
    mirror: merged.mirror !== false,
    fitMode: merged.fitMode === 'contain' ? 'contain' : 'cover',
    cropXPercent: Math.min(100, Math.max(0, Number(merged.cropXPercent))),
    cropYPercent: Math.min(100, Math.max(0, Number(merged.cropYPercent))),
    opacity: Math.min(1, Math.max(0.1, Number(merged.opacity)))
  };
}

async function desktopChatOverlayGeometry(overlaySettings?: Partial<ChatOverlaySettings>) {
  const normalized = clampOverlaySettings(overlaySettings);
  const fallbackW = DESKTOP_CHAT_OVERLAY_WIDTH;
  const fallbackH = DESKTOP_CHAT_OVERLAY_HEIGHT;
  try {
    const monitors = await availableMonitors();
    const monitor = monitors.find((item) => item.name === normalized.monitorName)
      || monitors.find((item) => item.position.x === 0 && item.position.y === 0)
      || monitors[0];
    if (monitor) {
      const scale = Math.max(0.5, Number(monitor.scaleFactor || 1));
      const originX = Math.round(monitor.position.x / scale);
      const originY = Math.round(monitor.position.y / scale);
      const screenW = Math.max(320, Math.round(monitor.size.width / scale));
      const screenH = Math.max(240, Math.round(monitor.size.height / scale));
      const width = Math.min(screenW, Math.max(180, Math.round(screenW * normalized.widthPercent / 100)));
      const height = Math.min(screenH, Math.max(90, Math.round(screenH * normalized.heightPercent / 100)));
      const rawX = originX + Math.round((screenW - width) * normalized.xPercent / 100);
      const rawY = originY + Math.round((screenH - height) * normalized.yPercent / 100);
      const x = Math.min(originX + screenW - width, Math.max(originX, rawX));
      const y = Math.min(originY + screenH - height, Math.max(originY, rawY));
      return { width, height, x, y, monitorName: monitor.name || '' };
    }
  } catch {
    // Browser/dev fallback below.
  }
  const screenW = window.screen?.availWidth || 1280;
  const screenH = window.screen?.availHeight || 720;
  const width = Math.max(180, Math.round(screenW * normalized.widthPercent / 100)) || fallbackW;
  const height = Math.max(90, Math.round(screenH * normalized.heightPercent / 100)) || fallbackH;
  return { width, height, x: Math.round((screenW - width) * normalized.xPercent / 100), y: Math.round((screenH - height) * normalized.yPercent / 100), monitorName: '' };
}

async function hardenDesktopChatOverlayWindow(
  overlay: WebviewWindow,
  geometry: { width: number; height: number; x: number; y: number },
  interactive = false
) {
  const overlayApi = overlay as any;
  await Promise.allSettled([
    overlayApi.setAlwaysOnTop?.(true),
    overlayApi.setSkipTaskbar?.(true),
    overlayApi.setIgnoreCursorEvents?.(!interactive),
    overlayApi.setResizable?.(interactive),
    overlayApi.setVisibleOnAllWorkspaces?.(true),
    overlayApi.setSize?.(new LogicalSize(geometry.width, geometry.height)),
    overlayApi.setPosition?.(new LogicalPosition(geometry.x, geometry.y)),
    overlayApi.show?.()
  ]);
}

function ChatOverlayWindow() {
  const [items, setItems] = useState<OverlayMessageItem[]>([]);
  const [overlaySettings, setOverlaySettings] = useState<ChatOverlaySettings>(DEFAULT_SETTINGS.chatOverlay);
  useEffect(() => {
    document.documentElement.classList.add('chat-overlay-root');
    document.body.classList.add('chat-overlay-body');
    return () => {
      document.documentElement.classList.remove('chat-overlay-root');
      document.body.classList.remove('chat-overlay-body');
    };
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<OverlayMessageItem[]>('mhlko://chat-overlay-update', (event) => {
      setItems(Array.isArray(event.payload) ? event.payload.slice(-5) : []);
    }).then((fn) => { unlisten = fn; }).catch(() => undefined);
    return () => { try { unlisten?.(); } catch { /* ignore */ } };
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<ChatOverlaySettings>('mhlko://chat-overlay-settings', (event) => {
      setOverlaySettings(clampOverlaySettings(event.payload));
    }).then((fn) => { unlisten = fn; }).catch(() => undefined);
    return () => { try { unlisten?.(); } catch { /* ignore */ } };
  }, []);
  return <main className={`desktop-chat-overlay-window ${overlaySettings.interactive ? 'interactive' : 'click-through'}`} aria-label="MHTalk Chat Overlay" style={{ opacity: overlaySettings.opacity, borderRadius: `${overlaySettings.borderRadius}px`, pointerEvents: overlaySettings.interactive ? 'auto' : 'none' }}>
    {overlaySettings.interactive && <div className="desktop-overlay-mode-badge">MHTalk • Interactive</div>}
    {items.length === 0 && <div className="desktop-chat-overlay-empty"><b>MHTalk</b><span>{TEXT.en.chatOverlayEmpty}</span></div>}
    {items.map((message, index) => <div key={`${message.senderName}-${index}`} className={`overlay-item ${message.kind || 'text'}`}><b>{message.senderName}</b>{message.kind === 'image' ? <img src={message.dataUrl} alt={message.body || 'media'} /> : message.kind === 'audio' ? <span>🎙️ {message.body}</span> : <span>{message.body}</span>}</div>)}
  </main>;
}

function VoiceMessagePlayer({ message }: { message: ChatMessage }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const waveform = message.waveform?.length ? message.waveform : Array.from({ length: 36 }, () => 0.22);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.load();
    const onTime = () => setProgress(audio.duration > 0 ? Math.min(1, audio.currentTime / audio.duration) : 0);
    const onPause = () => setPlaying(false);
    const onPlay = () => setPlaying(true);
    const onEnded = () => {
      audio.currentTime = 0;
      setProgress(0);
      setPlaying(false);
      if (currentVoiceMessageAudio === audio) currentVoiceMessageAudio = null;
    };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('ended', onEnded);
      if (currentVoiceMessageAudio === audio) currentVoiceMessageAudio = null;
    };
  }, [message.dataUrl]);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (currentVoiceMessageAudio && currentVoiceMessageAudio !== audio) {
      try { currentVoiceMessageAudio.pause(); } catch { /* ignore */ }
    }
    currentVoiceMessageAudio = audio;
    audio.play().catch(() => undefined);
  };

  return <div className="voice-message old-voice-message">
    <button className={`voice-play-button ${playing ? 'playing' : ''}`} onClick={toggle} aria-label={playing ? 'Stop voice message' : 'Play voice message'} title={playing ? 'Stop' : 'Play'}>▶</button>
    <div className="waveform voice-waveform" style={{ '--voice-progress': progress } as CSSProperties}>
      {waveform.map((bar, index) => <i key={index} className={index / Math.max(1, waveform.length - 1) <= progress ? 'played' : ''} style={{ height: `${Math.max(8, Math.round(bar * 34))}px` }} />)}
    </div>
    <audio ref={audioRef} className="hidden-audio voice-message-audio" src={message.dataUrl} preload="metadata" controls={false} hidden aria-hidden="true" tabIndex={-1} style={{ display: 'none' }} />
  </div>;
}

function mediaSrcFromMessage(message: ChatMessage): string | undefined {
  if (message.dataUrl) return message.dataUrl;
  if (message.localPath) return convertFileSrc(message.localPath);
  return undefined;
}

function renderMessageContent(message: ChatMessage, args?: { onImageOpen?: (preview: ImagePreview) => void; onMediaContextMenu?: (event: ReactMouseEvent<HTMLElement>, media: MediaPreview) => void; onFileMenu?: (event: ReactMouseEvent<HTMLElement>, message: ChatMessage) => void; t?: (key: string) => string }) {
  if (message.deletedAt) return <p className="deleted-message">{args?.t?.('deletedMessage') || 'Message deleted'}</p>;
  const mediaSrc = mediaSrcFromMessage(message);
  const isVoiceMessage = Boolean(message.dataUrl) && (message.kind === 'audio' || Boolean(message.waveform?.length) || Boolean(message.mimeType?.startsWith('audio/')) || /^voice-\d+\.webm$/i.test(message.fileName || ''));
  if (isVoiceMessage) return <VoiceMessagePlayer message={message} />;
  const isImageMessage = message.kind === 'image' || Boolean(message.mimeType?.startsWith('image/'));
  const isVideoMessage = message.kind === 'video' || Boolean(message.mimeType?.startsWith('video/')) || /\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(message.fileName || '');
  if (isImageMessage && mediaSrc) {
    const media: MediaPreview = { src: mediaSrc, name: message.fileName, kind: 'image', localPath: message.localPath };
    return <button className="media-open image-context-target" data-image-context="true" onClick={() => args?.onImageOpen?.({ src: mediaSrc, name: message.fileName })} onContextMenu={(event) => args?.onMediaContextMenu?.(event, media)} title={args?.t?.('openImage') || 'Open image'}><img className="chat-media" src={mediaSrc} alt={message.fileName || 'image'} /></button>;
  }
  if (isVideoMessage && mediaSrc) {
    return <div className="chat-video-wrap"><video className="chat-media chat-video-player" src={mediaSrc} controls playsInline preload="metadata" /></div>;
  }
  if (message.localPath || message.transferId || typeof message.fileSize === 'number') {
    const status = message.fileStatus || (message.localPath ? 'completed' : 'sending');
    const progress = Math.max(0, Math.min(100, Number(message.uploadProgress || (status === 'completed' ? 100 : 0))));
    return <div className={`file-transfer-card ${status}`}>
      <div className="file-transfer-head"><strong>{message.fileName || message.body || (args?.t?.('fileLabel') || 'file')}</strong>{status === 'completed' && <button className="file-kebab" aria-label={args?.t?.('fileActions') || 'File actions'} title={args?.t?.('fileActions') || 'File actions'} onClick={(event) => args?.onFileMenu?.(event, message)}>⋮</button>}</div>
      <small>{formatBytes(message.transferredBytes || 0)} / {formatBytes(message.fileSize || 0)} • {args?.t?.(`status_${status}`) || status}</small>
      {status !== 'completed' && <div className="file-progress"><i style={{ width: `${progress}%` }} /></div>}
      {message.localPath && status === 'completed' && <button onClick={() => invoke('open_received_file', { path: message.localPath }).catch(() => undefined)}>{args?.t?.('openFile') || 'Open'}</button>}
    </div>;
  }
  if (message.kind === 'file' && message.dataUrl) return <div className="file-transfer-card completed"><div className="file-transfer-head"><a className="file-link" href={message.dataUrl} download={message.fileName || 'file'}>{message.fileName || 'file'}</a><button className="file-kebab" aria-label={args?.t?.('fileActions') || 'File actions'} title={args?.t?.('fileActions') || 'File actions'} onClick={(event) => args?.onFileMenu?.(event, message)}>⋮</button></div></div>;
  const preview = message.linkPreview || linkPreviewFromText(message.body);
  return <div className="text-with-preview"><p>{message.body}</p>{preview && <a className="link-preview-card" href={preview.url} target="_blank" rel="noreferrer">{preview.image && <img src={preview.image} alt="thumbnail" />}<span><b>{preview.title}</b><small>{preview.provider || preview.url}</small></span></a>}</div>;
}

function peerInitial(peer?: PeerProfile | null) {
  return (peer?.displayName || 'M').slice(0, 1).toUpperCase();
}

export default function App() {
  if (new URLSearchParams(window.location.search).get('overlay') === 'chat') return <ChatOverlayWindow />;
  const queryClient = useQueryClient();
  const roomRef = useRef<RealtimeRoom | null>(null);
  const activeVideoRef = useRef<HTMLVideoElement | null>(null);
  const mediaBoxRef = useRef<HTMLDivElement | null>(null);
  const joinBellRef = useRef<HTMLButtonElement | null>(null);
  const joinPopoverRef = useRef<HTMLDivElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderReleaseRef = useRef<(() => void) | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const companionVoiceRecordingIdRef = useRef('');
  const voiceRecordStopRequestedRef = useRef(false);
  const voiceRecordStopInFlightRef = useRef(false);
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const typingTimersRef = useRef<Record<string, number>>({});
  const typingStopTimerRef = useRef<number | null>(null);
  const lastTypingSentRef = useRef(0);
  const previousPeerIdsRef = useRef<Set<string>>(new Set());
  const closedStreamPeersRef = useRef<Set<string>>(new Set());
  const updaterAutoCheckedRef = useRef(false);
  const pendingUpdateRef = useRef<any | null>(null);
  const micTestUnlistenRef = useRef<(() => void) | null>(null);
  const micTestErrorUnlistenRef = useRef<(() => void) | null>(null);
  const autoOpenedJoinRequestIdsRef = useRef<Set<string>>(new Set());
  const pendingAttachmentKeysRef = useRef<Set<string>>(new Set());
  const sendingAttachmentsRef = useRef(false);
  const shutdownInProgressRef = useRef(false);
  const allowWindowCloseRef = useRef(false);
  const chatOverlayWindowRef = useRef<WebviewWindow | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraDragRef = useRef<{ mode: 'move' | 'resize'; startX: number; startY: number; start: CameraBox } | null>(null);
  const isRoomOwnerRef = useRef(false);
  const micEnabledRef = useRef(false);
  const voiceActiveRef = useRef(false);
  const forcedMutedByAdminRef = useRef(false);
  const preForcedLocalMicEnabledRef = useRef<boolean | null>(null);
  const globalMuteSnapshotRef = useRef<Record<string, boolean> | null>(null);
  const globalMuteActiveRef = useRef(false);
  const seenReceiptSentRef = useRef<Set<string>>(new Set());
  const messagesRef = useRef<ChatMessage[]>([]);
  const historySyncedPeerIdsRef = useRef<Set<string>>(new Set());
  const micPromptShownForRoomRef = useRef(false);
  const cameraWithStreamArmedRef = useRef(false);
  const cameraOverlayStartPromiseRef = useRef<Promise<MediaStream | null> | null>(null);
  const screenRecorderControllerRef = useRef<ScreenRecorderController | null>(null);
  const screenRecorderAutoStreamIdRef = useRef('');
  const screenRecorderManualStartRef = useRef(false);
  const screenRecorderResumeSessionRef = useRef('');
  const screenRecorderPriorOutputDeviceRef = useRef<string | null>(null);
  const registeredGlobalHotkeysRef = useRef<Set<string>>(new Set());
  const hotkeyRegistrationGenerationRef = useRef(0);
  const hotkeyActionHandlerRef = useRef<(action: HotkeyAction) => void>(() => undefined);
  const voiceRecordStartInFlightRef = useRef(false);
  const overlayInteractiveRef = useRef(DEFAULT_SETTINGS.chatOverlay.interactive);
  const lastPublishedProfileAssetRef = useRef('');

  const [ready, setReady] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [settings, setSettingsState] = useState<AppSettings | null>(null);
  const [draftSettings, setDraftSettings] = useState<AppSettings | null>(null);
  const [devices, setDevices] = useState<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[]; cameras: MediaDeviceInfo[] }>({ inputs: [], outputs: [], cameras: [] });
  const [roomId, setRoomId] = useState('');
  const [roomCopied, setRoomCopied] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [connection, setConnection] = useState<ConnectionState>('idle');
  const [connectionLabel, setConnectionLabel] = useState('state_idle');
  const [peers, setPeers] = useState<Record<string, PeerProfile>>({});
  const [profileAssetAccess, setProfileAssetAccess] = useState<ProfileAssetAccess | null>(null);
  const [peerMedia, setPeerMedia] = useState<Record<string, { micEnabled: boolean; screenSharing: boolean; cameraSharing?: boolean }>>({});
  const [screenStreams, setScreenStreams] = useState<Record<string, MediaStream>>({});
  const [peerVolumes, setPeerVolumes] = useState<Record<string, PeerVolume>>({});
  const [activePeerId, setActivePeerId] = useState('');
  const [privateTarget, setPrivateTarget] = useState<string>('');
  const [peerMenuId, setPeerMenuId] = useState<string>('');
  const [voiceActive, setVoiceActive] = useState(false);
  const [micEnabled, setMicEnabled] = useState(false);
  const [screenSharing, setScreenSharing] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const [windowFocused, setWindowFocused] = useState(true);
  const [localPeerId, setLocalPeerId] = useState('');
  const [isRoomOwner, setIsRoomOwner] = useState(false);
  const [ownerPeerId, setOwnerPeerId] = useState('');
  const [typingUsers, setTypingUsers] = useState<Record<string, string>>({});
  const [highlightedMessageId, setHighlightedMessageId] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [draggingAttachments, setDraggingAttachments] = useState(false);
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null);
  const [mediaContextMenu, setMediaContextMenu] = useState<MediaContextMenu | null>(null);
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenu | null>(null);
  const [fileSaveProgress, setFileSaveProgress] = useState<FileSaveProgress | null>(null);
  const [selfMediaMenu, setSelfMediaMenu] = useState<SelfMediaMenu | null>(null);
  const [selfPreviewOpen, setSelfPreviewOpen] = useState(false);
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bannedMembers, setBannedMembers] = useState<BannedMember[]>([]);
  const [banModalOpen, setBanModalOpen] = useState(false);
  const [speakingPeers, setSpeakingPeers] = useState<Record<string, boolean>>({});
  const [joinRequests, setJoinRequests] = useState<Record<string, JoinRequest>>({});
  const [joinRequestsOpen, setJoinRequestsOpen] = useState(false);
  const [roomRoles, setRoomRoles] = useState<Record<string, RoomRole>>({});
  const [pendingVoice, setPendingVoice] = useState<PendingVoiceMessage | null>(null);
  const [hotkeysOpen, setHotkeysOpen] = useState(false);
  const [learningHotkey, setLearningHotkey] = useState<HotkeyAction | null>(null);
  const [errorLogOpen, setErrorLogOpen] = useState(false);
  const [errorLog, setErrorLog] = useState<LogEntry[]>([]);
  const [streamVolumeOpen, setStreamVolumeOpen] = useState(false);
  const [pipPeerId, setPipPeerId] = useState('');
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateProgress, setUpdateProgress] = useState('');
  const [requiredUpdate, setRequiredUpdate] = useState<{ version: string; notes: string } | null>(null);
  const [updateGateChecked, setUpdateGateChecked] = useState(false);
  const [micTestActive, setMicTestActive] = useState(false);
  const [micTestLevel, setMicTestLevel] = useState(0);
  const [streamRefreshTokens, setStreamRefreshTokens] = useState<Record<string, number>>({});
  const [voiceEngineStatus, setVoiceEngineStatus] = useState<VoiceEngineStatus | null>(null);
  const [chatOverlayOpen, setChatOverlayOpen] = useState(false);
  const [chatOverlayExternal, setChatOverlayExternal] = useState(false);
  const [overlayEditorOpen, setOverlayEditorOpen] = useState(false);
  const [overlayDraft, setOverlayDraft] = useState<ChatOverlaySettings | null>(null);
  const [overlayMonitors, setOverlayMonitors] = useState<Array<{ name: string; label: string }>>([]);
  const [cameraSettingsOpen, setCameraSettingsOpen] = useState(false);
  const [cameraModeChoiceOpen, setCameraModeChoiceOpen] = useState(false);
  const [cameraMode, setCameraMode] = useState<'camera-only' | 'camera-with-stream'>('camera-only');
  const [cameraDraft, setCameraDraft] = useState<CameraOverlaySettings | null>(null);
  const [activeMediaMode, setActiveMediaMode] = useState<'screen' | 'camera'>('screen');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraWithStreamArmed, setCameraWithStreamArmed] = useState(false);
  const [screenRecorderOpen, setScreenRecorderOpen] = useState(false);
  const [screenRecorderDraft, setScreenRecorderDraft] = useState<ScreenRecorderSettings>({ ...DEFAULT_SCREEN_RECORDER });
  const [screenRecorderState, setScreenRecorderState] = useState<ScreenRecorderRuntimeState>('idle');
  const [screenRecorderInfo, setScreenRecorderInfo] = useState<ScreenRecorderSourceInfo | null>(null);
  const [screenRecorderBytes, setScreenRecorderBytes] = useState(0);
  const [screenRecorderElapsed, setScreenRecorderElapsed] = useState(0);
  const [screenRecorderSavedPath, setScreenRecorderSavedPath] = useState('');
  const [screenRecorderError, setScreenRecorderError] = useState('');
  const [screenRecorderArmed, setScreenRecorderArmed] = useState(false);
  const [screenRecorderRecoveryOpen, setScreenRecorderRecoveryOpen] = useState(false);
  const [recoverableScreenRecordings, setRecoverableScreenRecordings] = useState<RecoverableScreenRecording[]>([]);
  const [screenRecorderRecoveryBusy, setScreenRecorderRecoveryBusy] = useState('');
  const [screenRecorderDependency, setScreenRecorderDependency] = useState<RecorderDependencyStatus>({ state: 'missing', message: '' });
  const [screenRecorderLevels, setScreenRecorderLevels] = useState<ScreenRecorderAudioLevels>({ mic: 0, members: 0, system: 0, mixed: 0 });
  const [screenRecorderFinalization, setScreenRecorderFinalization] = useState('');
  const [micJoinPromptOpen, setMicJoinPromptOpen] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraSetupPreviewStream, setCameraSetupPreviewStream] = useState<MediaStream | null>(null);
  const [cameraStreams, setCameraStreams] = useState<Record<string, MediaStream>>({});
  const [cameraBox, setCameraBox] = useState<CameraBox>({ x: DEFAULT_CAMERA_OVERLAY.xPercent, y: DEFAULT_CAMERA_OVERLAY.yPercent, width: DEFAULT_CAMERA_OVERLAY.widthPercent, height: DEFAULT_CAMERA_OVERLAY.heightPercent });
  const [adminMutedPeers, setAdminMutedPeers] = useState<Record<string, boolean>>({});
  const [forcedMutedByAdmin, setForcedMutedByAdmin] = useState(false);
  const [globalMuteActive, setGlobalMuteActive] = useState(false);
  const [speakRequests, setSpeakRequests] = useState<Record<string, SpeakRequest>>({});
  const [raiseHandLastAt, setRaiseHandLastAt] = useState(0);
  const [voiceProfile, setVoiceProfile] = useState<'high' | 'balanced' | 'low'>('balanced');
  const [voicePressure, setVoicePressure] = useState<'normal' | 'pressure' | 'severe'>('normal');
  const voicePressureRef = useRef<'normal' | 'pressure' | 'severe'>('normal');
  const lastOverlayPublishRef = useRef(0);
  const cameraReducedForVoiceRef = useRef(false);
  const speakingTimersRef = useRef<Record<string, number>>({});

  const activeSettings = useMemo(() => settings ? applyLowMode(settings) : null, [settings]);
  const selectedInputLabel = useCallback((deviceId?: string) => devices.inputs.find((device) => device.deviceId === deviceId)?.label || '', [devices.inputs]);
  const selectedOutputLabel = useCallback((deviceId?: string) => devices.outputs.find((device) => device.deviceId === deviceId)?.label || '', [devices.outputs]);
  const startRoomVoice = useCallback((room: RealtimeRoom) => room.startVoice(
    activeSettings?.audioInputId || undefined,
    activeSettings?.audioOutputId || undefined,
    selectedInputLabel(activeSettings?.audioInputId),
    selectedOutputLabel(activeSettings?.audioOutputId),
    Boolean(activeSettings?.voiceEnhanceEnabled)
  ), [activeSettings?.audioInputId, activeSettings?.audioOutputId, activeSettings?.voiceEnhanceEnabled, selectedInputLabel, selectedOutputLabel]);

  const lang: AppLanguage = settings?.language || 'ar';
  const isRtl = RTL_LANGUAGES.includes(lang);
  const t = (key: string) => TEXT[lang]?.[key] ?? key;
  const peerList = useMemo(() => Object.values(peers), [peers]);
  const profileAssetDescriptors = useMemo(
    () => peerList.map((peer) => ({ peerId: peer.peerId, avatarVersion: peer.avatarVersion })).sort((left, right) => left.peerId.localeCompare(right.peerId)),
    [peerList]
  );
  const profileAssetSignature = useMemo(
    () => profileAssetDescriptors.map((peer) => `${peer.peerId}:${peer.avatarVersion || 'none'}`).join('|'),
    [profileAssetDescriptors]
  );
  const profileAssetsQuery = useQuery({
    queryKey: ['profile-assets', roomId, profileAssetAccess?.generation || 0, profileAssetSignature],
    queryFn: ({ signal }) => fetchProfileAssets(profileAssetAccess!, profileAssetDescriptors, signal),
    enabled: Boolean(profileAssetAccess && profileAssetDescriptors.length > 0),
    staleTime: Number.POSITIVE_INFINITY
  });
  const publishProfileAssetMutation = useMutation({
    mutationFn: (input: { access: ProfileAssetAccess; avatar: string | null; version: string }) => publishProfileAvatar(input.access, input.avatar, input.version),
    retry: (failureCount, error) => failureCount < 2 && (error instanceof TypeError || /failed to fetch/i.test(String((error as Error)?.message || error))),
    retryDelay: (attempt) => Math.min(2500, 500 * (2 ** attempt))
  });

  useEffect(() => {
    const assets = profileAssetsQuery.data;
    if (!assets) return;
    setPeers((current) => {
      let changed = false;
      const next: Record<string, PeerProfile> = {};
      for (const [peerId, peer] of Object.entries(current)) {
        const asset = assets[peerId];
        const avatar = asset && asset.version === peer.avatarVersion ? asset.avatar : null;
        const peerChanged = (peer.avatar || null) !== avatar;
        if (peerChanged) changed = true;
        next[peerId] = peerChanged ? { ...peer, avatar } : peer;
      }
      return changed ? next : current;
    });
  }, [profileAssetsQuery.data]);

  useEffect(() => {
    if (!profileAssetAccess || !profile) return;
    const version = profileAvatarVersion(profile.avatar_data_url);
    const publishKey = `${profileAssetAccess.endpointUrl}|${profileAssetAccess.generation}|${version}`;
    if (lastPublishedProfileAssetRef.current === publishKey) return;
    lastPublishedProfileAssetRef.current = publishKey;
    publishProfileAssetMutation.mutate(
      { access: profileAssetAccess, avatar: profile.avatar_data_url, version },
      {
        onSuccess: () => {
          roomRef.current?.announceProfile();
          queryClient.invalidateQueries({ queryKey: ['profile-assets', roomId] }).catch(() => undefined);
        },
        onError: (error) => {
          addLog(`Profile asset publish failed: ${String((error as Error)?.message || error)}`, 'error');
        }
      }
    );
  }, [profileAssetAccess, profile?.avatar_data_url, publishProfileAssetMutation, profile, queryClient, roomId]);
  const displayConnectionLabel = t(connectionLabel) || t(`state_${connection}`) || connectionLabel;
  const typingNames = Object.values(typingUsers);
  const activePeer = activePeerId ? peers[activePeerId] : undefined;
  const activeStream = activePeer?.peerId ? (activeMediaMode === 'camera' ? cameraStreams[activePeer.peerId] : screenStreams[activePeer.peerId]) : undefined;
  const activeHasScreen = activePeer?.peerId ? Boolean(peerMedia[activePeer.peerId]?.screenSharing && screenStreams[activePeer.peerId]?.getVideoTracks().some((track) => track.readyState === 'live')) : false;
  const activeHasCamera = activePeer?.peerId ? Boolean(peerMedia[activePeer.peerId]?.cameraSharing && cameraStreams[activePeer.peerId]?.getVideoTracks().some((track) => track.readyState === 'live')) : false;
  const activeHasMedia = activeMediaMode === 'camera' ? activeHasCamera : activeHasScreen;
  const streamViewerOpen = Boolean(activePeerId && activeHasMedia);
  const activeScreenAudioPeerId = streamViewerOpen && activeMediaMode === 'screen' ? activePeerId : '';
  const localCameraPanelOpen = false;
  const mediaPanelOpen = streamViewerOpen;
  const streamingPeerIds = useMemo(() => peerList.filter((peer) => peerMedia[peer.peerId]?.screenSharing || peerMedia[peer.peerId]?.cameraSharing).map((peer) => peer.peerId), [peerList, peerMedia]);
  const activePeerVolume = activePeer?.peerId ? (peerVolumes[activePeer.peerId] || defaultVolume()) : defaultVolume();
  const canModerate = isRoomOwner || roomRoles[localPeerId] === 'moderator';
  const waitingForApproval = roomId && connectionLabel === 'state_waiting_approval';
  const overlayMessages = useMemo<OverlayMessageItem[]>(() => {
    const config = settings?.chatOverlay || DEFAULT_SETTINGS.chatOverlay;
    const protectVoice = voicePressure !== 'normal';
    const visibleLimit = protectVoice ? 3 : 5;
    return messages.filter((message) => {
      if (message.sender === 'system' || message.deletedAt) return false;
      const kind = message.kind || 'text';
      if (kind === 'text') return config.showText;
      if (kind === 'image') return config.showImages;
      if (kind === 'audio') return config.showAudio;
      return config.showText;
    }).slice(-visibleLimit).map((message) => {
      const kind = message.kind || 'text';
      const shouldRenderMedia = !protectVoice && kind === 'image';
      return {
        senderName: message.senderName,
        body: kind === 'audio' ? (message.fileName || 'Voice message') : kind === 'image' ? (message.body || 'Media') : message.body,
        kind: protectVoice && kind === 'image' ? 'text' : kind,
        dataUrl: shouldRenderMedia ? message.dataUrl : undefined
      };
    });
  }, [messages, settings?.chatOverlay, voicePressure]);
  const availableQualityOptions = useMemo(() => qualityOptionsForScreen(), []);
  const availableFpsOptions = useMemo(() => fpsOptionsForScreen(), []);
  const settingsForm = draftSettings || settings || DEFAULT_SETTINGS;
  const settingsDirty = Boolean(settings && JSON.stringify(settingsForm) !== JSON.stringify(settings));
  useEffect(() => {
    if (!screenRecorderOpen && settings?.screenRecorder) setScreenRecorderDraft({ ...settings.screenRecorder });
  }, [settings?.screenRecorder, screenRecorderOpen]);

  useEffect(() => {
    if (!['recording', 'paused'].includes(screenRecorderState)) return;
    screenRecorderControllerRef.current?.updateAudioMix(screenRecorderDraft);
  }, [
    screenRecorderState,
    screenRecorderDraft.includeMic,
    screenRecorderDraft.includeMembers,
    screenRecorderDraft.includeSystem,
    screenRecorderDraft.micVolume,
    screenRecorderDraft.membersVolume,
    screenRecorderDraft.systemVolume,
    screenRecorderDraft.autoDuckSystem
  ]);

  useEffect(() => {
    if (screenRecorderState !== 'recording') return;
    const timer = window.setInterval(() => setScreenRecorderElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [screenRecorderState]);

  useEffect(() => {
    roomRef.current?.setRecordingActive(['starting', 'recording', 'paused', 'stopping'].includes(screenRecorderState));
  }, [screenRecorderState]);

  useEffect(() => {
    const stream = localScreenStream || roomRef.current?.getLocalScreenStream() || null;
    if (!screenSharing || !stream) {
      screenRecorderAutoStreamIdRef.current = '';
      if (screenRecorderState === 'recording' || screenRecorderState === 'paused') {
        stopScreenRecording(true).catch(() => undefined);
      }
      return;
    }
    // A manual toolbar click owns this start cycle. This prevents auto-start from racing it.
    if (screenRecorderManualStartRef.current || screenRecorderArmed) return;
    if (cameraWithStreamArmedRef.current && !cameraOpen) return;
    if (!settings?.screenRecorder?.autoStart) return;
    const streamId = stream.id || stream.getVideoTracks()[0]?.id || 'screen';
    if (screenRecorderAutoStreamIdRef.current === streamId) return;
    if (screenRecorderState !== 'idle' && screenRecorderState !== 'error') return;
    screenRecorderAutoStreamIdRef.current = streamId;
    setScreenRecorderDraft({ ...settings.screenRecorder });
    startScreenRecording(settings.screenRecorder, '', stream).catch(() => undefined);
  }, [screenSharing, localScreenStream, settings?.screenRecorder, screenRecorderState, screenRecorderArmed, cameraOpen]);

  useEffect(() => {
    let cancelled = false;
    prepareScreenRecorderDependencies()
      .then((status) => { if (!cancelled) setScreenRecorderDependency(status); })
      .catch(() => undefined);
    listRecoverableScreenRecordings()
      .then((items) => { if (!cancelled) setRecoverableScreenRecordings(items); })
      .catch(() => undefined);
    const timer = window.setInterval(() => {
      getScreenRecorderDependencyStatus()
        .then((status) => {
          if (cancelled) return;
          setScreenRecorderDependency(status);
          if (status.state === 'ready' || status.state === 'error') window.clearInterval(timer);
        })
        .catch(() => undefined);
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => () => {
    const controller = screenRecorderControllerRef.current;
    if (controller && controller.getState() !== 'idle') controller.preserve().catch(() => undefined);
  }, []);
  useEffect(() => { isRoomOwnerRef.current = isRoomOwner; }, [isRoomOwner]);
  useEffect(() => { micEnabledRef.current = micEnabled; }, [micEnabled]);
  useEffect(() => { voiceActiveRef.current = voiceActive; }, [voiceActive]);
  useEffect(() => { forcedMutedByAdminRef.current = forcedMutedByAdmin; }, [forcedMutedByAdmin]);
  useEffect(() => {
    if (chatOverlayOpen && chatOverlayExternal) {
      const minInterval = voicePressure === 'normal' ? 250 : 1500;
      const now = Date.now();
      if (now - lastOverlayPublishRef.current < minInterval) return;
      lastOverlayPublishRef.current = now;
      emit('mhlko://chat-overlay-update', overlayMessages).catch(() => undefined);
      emit('mhlko://chat-overlay-settings', settings?.chatOverlay || DEFAULT_SETTINGS.chatOverlay).catch(() => undefined);
    }
  }, [chatOverlayOpen, chatOverlayExternal, overlayMessages, settings?.chatOverlay, voicePressure]);

  useEffect(() => {
    if (!cameraOpen || !cameraStream) return;
    const track = cameraStream.getVideoTracks()[0];
    if (!track) return;
    if (voicePressure !== 'normal' && !cameraReducedForVoiceRef.current) {
      cameraReducedForVoiceRef.current = true;
      const severe = voicePressure === 'severe';
      track.applyConstraints({ width: { ideal: severe ? 160 : 320 }, height: { ideal: severe ? 90 : 180 }, frameRate: { ideal: severe ? 8 : 12, max: severe ? 8 : 12 } }).catch(() => undefined);
      addLog('Camera overlay reduced to protect microphone voice priority.', 'info');
    } else if (voicePressure === 'normal' && cameraReducedForVoiceRef.current) {
      cameraReducedForVoiceRef.current = false;
      // Return to source/default behavior instead of forcing a heavy camera mode.
      track.applyConstraints({}).catch(() => undefined);
      addLog('Camera overlay returned to source-default behavior after voice pressure cleared.', 'info');
    }
  }, [voicePressure, cameraOpen, cameraStream]);


  useEffect(() => {
    if (screenSharing && cameraWithStreamArmedRef.current && !cameraOpen) {
      ensureCameraWithStreamOverlay().catch(() => undefined);
    }
    if (!screenSharing && cameraMode === 'camera-with-stream' && cameraOpen) {
      toggleCameraOverlay('camera-with-stream').catch(() => undefined);
    }
  }, [screenSharing]);

  useEffect(() => {
    if (voicePressure === 'normal' && screenSharing && activeSettings) {
      roomRef.current?.updateScreenQuality(activeSettings.screenQuality, activeSettings.screenFps).catch(() => undefined);
    }
  }, [voicePressure, screenSharing, activeSettings?.screenQuality, activeSettings?.screenFps]);

  useEffect(() => {
    if (settings?.cameraOverlay) {
      const cam = clampCameraSettings(settings.cameraOverlay);
      setCameraBox({ x: cam.xPercent, y: cam.yPercent, width: cam.widthPercent, height: cam.heightPercent });
    }
  }, [settings?.cameraOverlay]);

  useEffect(() => {
    if (cameraVideoRef.current) cameraVideoRef.current.srcObject = cameraStream;
    if (cameraStream && cameraOpen) cameraVideoRef.current?.play().catch(() => undefined);
  }, [cameraStream, cameraOpen]);

  useEffect(() => () => {
    try { cameraStream?.getTracks().forEach((track) => track.stop()); } catch { /* ignore */ }
  }, [cameraStream]);

  function speakingColor(peerId: string) {
    const palette = ['#8b5cf6', '#06b6d4', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6', '#a855f7', '#3b82f6', '#84cc16'];
    let hash = 0;
    for (const char of peerId || 'local') hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return palette[hash % palette.length];
  }

  const updateSpeaking = useCallback((peerId: string, active: boolean) => {
    if (!peerId) return;
    const timers = speakingTimersRef.current;
    if (timers[peerId]) {
      window.clearTimeout(timers[peerId]);
      delete timers[peerId];
    }
    setSpeakingPeers((current) => current[peerId] === active ? current : { ...current, [peerId]: active });
    if (active) {
      timers[peerId] = window.setTimeout(() => {
        delete timers[peerId];
        setSpeakingPeers((current) => current[peerId] ? { ...current, [peerId]: false } : current);
      }, 850);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await initDb();
        const [loadedProfile, loadedSettings] = await Promise.all([loadProfile(), loadSettings()]);
        setProfile(loadedProfile);
        setSettingsState(loadedSettings);
        setDevices(await listMediaDevices());
        setReady(true);
      } catch (error) {
        setToast(TEXT[settings?.language || 'ar']?.dataProblem ?? 'dataProblem');
        console.error(error);
      }
    })();

    return () => roomRef.current?.close();
  }, []);

  useEffect(() => { messagesRef.current = messages; chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => () => { Object.values(speakingTimersRef.current).forEach((timer) => window.clearTimeout(timer)); }, []);
  useEffect(() => {
    if (isRoomOwner && forcedMutedByAdmin) {
      setForcedMutedByAdmin(false);
      setMicEnabled(true);
      roomRef.current?.setMicEnabled(true);
      addLog('Admin forced mute state repaired', 'info');
    }
  }, [isRoomOwner, forcedMutedByAdmin]);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    const onFocus = () => setWindowFocused(true);
    const onBlur = () => setWindowFocused(false);
    const onVisibilityChange = () => setWindowFocused(!document.hidden);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlistenClose: (() => void) | undefined;
    let unlistenTray: (() => void) | undefined;
    (async () => {
      unlistenClose = await getCurrentWindow().onCloseRequested(async (event) => {
        if (allowWindowCloseRef.current) return;
        event.preventDefault();
        await closeWindow(false);
      });
      unlistenTray = await listen('mhlko://tray-quit-requested', () => { closeWindow(false).catch(() => undefined); });
      if (disposed) {
        try { unlistenClose?.(); } catch { /* ignore */ }
        try { unlistenTray?.(); } catch { /* ignore */ }
      }
    })().catch(() => undefined);
    return () => {
      disposed = true;
      try { unlistenClose?.(); } catch { /* ignore */ }
      try { unlistenTray?.(); } catch { /* ignore */ }
    };
  }, [roomId]);


  useEffect(() => {
    setStreamVolumeOpen(false);
    if (pipPeerId && activePeerId !== pipPeerId) setPipPeerId('');
  }, [activePeerId]);

  useEffect(() => {
    if (screenSharing && activeSettings) roomRef.current?.updateScreenQuality(activeSettings.screenQuality, activeSettings.screenFps).catch(() => undefined);
  }, [activeSettings?.screenQuality, activeSettings?.screenFps, screenSharing]);

  useEffect(() => {
    if (settings?.notificationsEnabled) requestNotificationsIfNeeded(true);
  }, [settings?.notificationsEnabled]);

  useEffect(() => {
    if (settingsOpen && settings) setDraftSettings({ ...settings });
    if (!settingsOpen) setDraftSettings(null);
  }, [settingsOpen]);
  useEffect(() => {
    resizeComposerTextarea(messageInputRef.current);
  }, [draft]);


  useEffect(() => {
    if (!ready) return;
    invoke<VoiceEngineStatus>('voice_companion_status')
      .then((status) => setVoiceEngineStatus(status))
      .catch(() => setVoiceEngineStatus(null));
  }, [ready]);


  useEffect(() => {
    if (!ready || !settings) return;
    const enabled = Boolean(settings.voiceEnhanceEnabled);
    roomRef.current?.setVoiceEnhanceEnabled(enabled).catch((error) => addLog(String((error as Error)?.message || error || 'Voice Enhance error'), 'error'));
    setVoiceEngineStatus((current) => current ? { ...current, voiceEnhanceEnabled: enabled } : current);
  }, [ready, settings?.voiceEnhanceEnabled]);

  useEffect(() => {
    if (!ready || !settings) return;
    roomRef.current?.setVoiceOutputDevice(settings.audioOutputId || undefined).catch(() => undefined);
  }, [ready, settings?.audioOutputId]);

  useEffect(() => {
    if (!ready || updaterAutoCheckedRef.current) return;
    updaterAutoCheckedRef.current = true;
    const timer = window.setTimeout(() => {
      checkForUpdates(false).catch(() => { setUpdateGateChecked(true); });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [ready]);

  useEffect(() => () => stopMicTest(), []);

  useEffect(() => {
    if (!settingsOpen && !selfPreviewOpen && micTestActive) stopMicTest();
  }, [settingsOpen, selfPreviewOpen, micTestActive]);

  useEffect(() => {
    if (micTestActive) stopMicTest();
  }, [settings?.audioInputId, settings?.audioOutputId]);

  useEffect(() => () => {
    Object.values(typingTimersRef.current).forEach((timer) => window.clearTimeout(Number(timer)));
    if (typingStopTimerRef.current) window.clearTimeout(typingStopTimerRef.current);
  }, []);

  useEffect(() => {
    const blockNativeContextMenu = (event: Event) => {
      // 0.7.6: Chromium/WebView native context entries (Back, Refresh, Save as,
      // Print, More tools, Inspect, etc.) must never leak into the app. The only
      // right-click menu we intentionally show is the app's custom image menu.
      event.preventDefault();
    };
    document.addEventListener('contextmenu', blockNativeContextMenu, true);
    return () => document.removeEventListener('contextmenu', blockNativeContextMenu, true);
  }, []);

  useEffect(() => {
    if (!mediaContextMenu && !fileContextMenu && !selfMediaMenu) return;
    const closeMenus = () => { setMediaContextMenu(null); setFileContextMenu(null); setSelfMediaMenu(null); };
    const closeOnEsc = (event: KeyboardEvent) => { if (event.key === 'Escape') closeMenus(); };
    document.addEventListener('mousedown', closeMenus);
    document.addEventListener('keydown', closeOnEsc);
    return () => {
      document.removeEventListener('mousedown', closeMenus);
      document.removeEventListener('keydown', closeOnEsc);
    };
  }, [mediaContextMenu, fileContextMenu, selfMediaMenu]);

  useEffect(() => {
    const onError = (event: ErrorEvent) => addLog(event.message || 'Unknown window error', 'error');
    const onUnhandled = (event: PromiseRejectionEvent) => addLog(String(event.reason?.message || event.reason || 'Unhandled promise rejection'), 'error');
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandled);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandled);
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>('mhlko://native-voice-info', (event) => addLog(String(event.payload || 'Native voice info'), 'info'))
      .then((fn) => { unlisten = fn; })
      .catch(() => undefined);
    return () => { try { unlisten?.(); } catch { /* ignore */ } };
  }, []);

  useEffect(() => {
    let unlistenProgress: (() => void) | undefined;
    let unlistenStage: (() => void) | undefined;
    let unlistenComplete: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    listen<FileSaveProgress>('mhlko://file-save-progress', (event) => setFileSaveProgress(event.payload))
      .then((fn) => { unlistenProgress = fn; }).catch(() => undefined);
    listen<{ stage?: string; message?: string }>('mhlko://recording-finalization-stage', (event) => {
      const stageId = String(event.payload?.stage || 'unknown');
      const stage = String(event.payload?.message || stageId);
      setScreenRecorderFinalization(stage);
      addLog(`[recording:${stageId}] ${stage}`, 'info');
    }).then((fn) => { unlistenStage = fn; }).catch(() => undefined);
    listen<{ path?: string; size?: number }>('mhlko://recording-finalization-complete', (event) => {
      if (event.payload?.path) setScreenRecorderSavedPath(String(event.payload.path));
      if (Number.isFinite(Number(event.payload?.size))) setScreenRecorderBytes(Number(event.payload?.size));
      setScreenRecorderFinalization('');
      addLog(`[recording:complete] ${String(event.payload?.path || 'MP4 finalization complete')}`, 'info');
    }).then((fn) => { unlistenComplete = fn; }).catch(() => undefined);
    listen<{ message?: string; path?: string }>('mhlko://recording-finalization-error', (event) => {
      const message = String(event.payload?.message || 'MP4 finalization failed');
      setScreenRecorderFinalization('');
      addLog(`${message}${event.payload?.path ? ` • ${event.payload.path}` : ''}`, 'error');
    }).then((fn) => { unlistenError = fn; }).catch(() => undefined);
    return () => {
      for (const unlisten of [unlistenProgress, unlistenStage, unlistenComplete, unlistenError]) {
        try { unlisten?.(); } catch { /* ignore */ }
      }
    };
  }, []);

  useEffect(() => {
    overlayInteractiveRef.current = Boolean(settings?.chatOverlay?.interactive);
  }, [settings?.chatOverlay?.interactive]);

  useEffect(() => {
    if (!overlayEditorOpen) return;
    availableMonitors()
      .then((items) => setOverlayMonitors(items
        .filter((item) => Boolean(item.name))
        .map((item) => ({ name: String(item.name), label: String(item.name) }))))
      .catch(() => setOverlayMonitors([]));
  }, [overlayEditorOpen]);

  useEffect(() => {
    if (!cameraSettingsOpen || cameraOpen) {
      setCameraSetupPreviewStream((current) => {
        current?.getTracks().forEach((track) => { try { track.stop(); } catch { /* ignore */ } });
        return null;
      });
      return;
    }
    let cancelled = false;
    let preview: MediaStream | null = null;
    const deviceId = settingsForm.cameraInputId || undefined;
    navigator.mediaDevices.getUserMedia({
      video: deviceId
        ? { deviceId: { ideal: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }
        : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      audio: false
    }).then((stream) => {
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      preview = stream;
      setCameraSetupPreviewStream(stream);
    }).catch((error) => addLog(`Camera preview unavailable: ${String((error as Error)?.message || error)}`, 'error'));
    return () => {
      cancelled = true;
      preview?.getTracks().forEach((track) => { try { track.stop(); } catch { /* ignore */ } });
      setCameraSetupPreviewStream((current) => current === preview ? null : current);
    };
  }, [cameraSettingsOpen, cameraOpen, settingsForm.cameraInputId]);

  useEffect(() => {
    if (!joinRequestsOpen) return;
    const closeOnOutside = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (joinPopoverRef.current?.contains(target) || joinBellRef.current?.contains(target)) return;
      setJoinRequestsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setJoinRequestsOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutside, true);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutside, true);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [joinRequestsOpen]);

  hotkeyActionHandlerRef.current = (action: HotkeyAction) => {
    if (action === 'muteMic') toggleMicMute().catch(() => undefined);
    if (action === 'toggleScreen') toggleScreen().catch(() => undefined);
    if (action === 'endCall') leaveRoom(true).catch(() => undefined);
    if (action === 'toggleFullscreen') toggleFullscreen().catch(() => undefined);
    if (action === 'toggleSettings') setSettingsOpen((open) => !open);
    if (action === 'toggleOverlayMode') setDesktopOverlayInteractive(!overlayInteractiveRef.current).catch(() => undefined);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (learningHotkey || isTypingTarget(event.target)) return;
      const hotkeys: Record<HotkeyAction, string> = settings?.hotkeys || DEFAULT_HOTKEYS;
      const combo = formatHotkeyEvent(event);
      if (!combo) return;
      const matched = (Object.entries(hotkeys) as Array<[HotkeyAction, string]>).find(([, value]) => value && normalizeHotkeyCombo(value) === combo)?.[0];
      if (!matched) return;

      const nativeShortcut = toTauriShortcut(hotkeys[matched] || '');
      // When native global registration succeeded, its callback is the single source of
      // truth. This prevents a focused window from toggling the same action twice.
      if (nativeShortcut && registeredGlobalHotkeysRef.current.has(nativeShortcut)) return;

      event.preventDefault();
      hotkeyActionHandlerRef.current(matched);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [settings?.hotkeys, learningHotkey]);

  useEffect(() => {
    const generation = ++hotkeyRegistrationGenerationRef.current;
    registeredGlobalHotkeysRef.current = new Set();

    const registerAll = async () => {
      // Registration is rebuilt as one atomic set. This prevents an older React
      // effect cleanup from unregistering shortcuts that a newer settings save
      // has just installed.
      await unregisterAllGlobalShortcuts().catch((error) => {
        addLog(`Could not clear previous global hotkeys: ${String((error as Error)?.message || error)}`, 'error');
      });
      if (hotkeyRegistrationGenerationRef.current !== generation) return;

      const seen = new Set<string>();
      for (const [action, combo] of Object.entries(settings?.hotkeys || DEFAULT_HOTKEYS) as Array<[HotkeyAction, string]>) {
        if (hotkeyRegistrationGenerationRef.current !== generation) return;
        const shortcut = toTauriShortcut(combo);
        if (!shortcut || seen.has(shortcut)) continue;
        seen.add(shortcut);
        try {
          await registerGlobalShortcut(shortcut, (event) => {
            if (event.state !== 'Pressed') return;
            hotkeyActionHandlerRef.current(action);
          });
          if (hotkeyRegistrationGenerationRef.current !== generation) {
            await unregisterGlobalShortcut(shortcut).catch(() => undefined);
            return;
          }
          registeredGlobalHotkeysRef.current.add(shortcut);
          addLog(`Global hotkey registered: ${action}=${shortcut}`, 'info');
        } catch (error) {
          addLog(`Global hotkey unavailable: ${action}=${shortcut}: ${String((error as Error)?.message || error)}`, 'error');
        }
      }
    };

    registerAll().catch((error) => addLog(`Global hotkey registration failed: ${String((error as Error)?.message || error)}`, 'error'));
    return () => {
      if (hotkeyRegistrationGenerationRef.current === generation) {
        hotkeyRegistrationGenerationRef.current += 1;
        registeredGlobalHotkeysRef.current = new Set();
      }
    };
  }, [settings?.hotkeys]);

  useEffect(() => () => {
    hotkeyRegistrationGenerationRef.current += 1;
    registeredGlobalHotkeysRef.current = new Set();
    unregisterAllGlobalShortcuts().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!learningHotkey) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      if (event.key === 'Escape') {
        setLearningHotkey(null);
        return;
      }
      const combo = formatHotkeyEvent(event);
      if (!combo || !settings) return;
      persistHotkey(learningHotkey, combo).catch((error) => {
        addLog(`Hotkey save failed: ${String((error as Error)?.message || error)}`, 'error');
      });
      setLearningHotkey(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [learningHotkey, settings]);


  useEffect(() => {
    if (replyTo || editingMessage || privateTarget) {
      window.setTimeout(() => messageInputRef.current?.focus(), 20);
    }
  }, [replyTo, editingMessage, privateTarget]);

  function displayToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(''), 3500);
  }

  function showToast(message: string) {
    addLog(message, 'info');
    displayToast(message);
  }

  function addLog(message: string, level: LogEntry['level'] = 'info') {
    setErrorLog((current) => [{ id: nowId(), at: Date.now(), level, message }, ...current].slice(0, 1200));
  }

  function logLevelText(level: LogEntry['level']) {
    return t(level === 'error' ? 'log_error' : 'log_info');
  }

  function localizeLogMessage(message: string) {
    const raw = String(message || '');
    const direct = TEXT[lang]?.[raw];
    if (direct) return direct;
    const common: Array<[RegExp, string]> = [
      [/^File transfer cancel requested$/i, t('fileFailed')],
      [/^Media download failed$/i, t('mediaDownloadFailed')],
      [/^Media copy failed$/i, t('mediaCopyFailed')],
      [/^Event log downloaded/i, t('logDownloaded')],
      [/^Camera share stopped/i, t('cameraStop')],
      [/^Starting camera share/i, t('cameraStart')],
      [/^Remote camera available/i, t('viewCamera')],
      [/^Remote camera ended/i, t('cameraStop')],
      [/^Stream switched/i, t('switchStream')],
      [/^Camera view switched/i, t('viewCamera')],
      [/^Voice output device fallback/i, t('defaultDevice')],
      [/^Oversized file rejected/i, t('attachmentRejected') || t('fileTooLarge')]
    ];
    for (const [pattern, label] of common) if (pattern.test(raw)) return label;
    return raw;
  }

  function openMediaContext(event: ReactMouseEvent<HTMLElement>, media: MediaPreview) {
    event.preventDefault();
    event.stopPropagation();
    if (media.kind !== 'image') return;
    setMediaContextMenu({ ...media, x: event.clientX, y: event.clientY });
  }

  function mediaDefaultName(media: MediaPreview) {
    const fallback = media.kind === 'video' ? 'mhlkotalk-video.mp4' : 'mhlkotalk-image.png';
    return (media.name || fallback).replace(/[\\/:*?"<>|]/g, '_');
  }

  async function downloadMediaToDesktop(media: MediaPreview) {
    try {
      const fileName = mediaDefaultName(media);
      if (media.localPath) await invoke('copy_file_to_desktop', { path: media.localPath, fileName });
      else await invoke('save_data_url_to_desktop', { fileName, dataUrl: await mediaSourceToDataUrl(media.src) });
      showToast(t('mediaSavedToDesktop'));
    } catch (error) {
      addLog(String((error as Error)?.message || error || 'Media download failed'), 'error');
      showToast(t('mediaDownloadFailed'));
    } finally {
      setMediaContextMenu(null);
    }
  }

  async function copyMediaToClipboard(media: MediaPreview) {
    try {
      if (media.kind === 'image' && 'ClipboardItem' in window) {
        const response = await fetch(media.src);
        const blob = await response.blob();
        const ClipboardItemClass = (window as typeof window & { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
        if (ClipboardItemClass) {
          await navigator.clipboard.write([new ClipboardItemClass({ [blob.type || 'image/png']: blob })]);
          showToast(t('mediaCopied'));
          setMediaContextMenu(null);
          return;
        }
      }
      await navigator.clipboard.writeText(media.localPath || media.src);
      showToast(t('mediaCopied'));
    } catch (error) {
      addLog(String((error as Error)?.message || error || 'Media copy failed'), 'error');
      showToast(t('mediaCopyFailed'));
    } finally {
      setMediaContextMenu(null);
    }
  }

  function openFileContext(event: ReactMouseEvent<HTMLElement>, message: ChatMessage) {
    event.preventDefault();
    event.stopPropagation();
    const width = 250;
    const height = 190;
    setFileContextMenu({
      message,
      x: Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX)),
      y: Math.max(8, Math.min(window.innerHeight - height - 8, event.clientY))
    });
  }

  function safeDownloadName(message: ChatMessage): string {
    const raw = message.fileName || message.body || 'MHTalk-file';
    const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 180);
    return cleaned || 'MHTalk-file';
  }

  async function persistMessageFile(message: ChatMessage, mode: 'desktop' | 'save-as') {
    const fileName = safeDownloadName(message);
    const operationId = `file-save-${crypto.randomUUID()}`;
    setFileSaveProgress({ operationId, written: 0, total: Number(message.fileSize || 0), targetPath: '' });
    try {
      if (mode === 'desktop') {
        if (message.localPath) {
          await invoke<string>('copy_file_to_desktop', { path: message.localPath, fileName, operationId });
        } else if (message.dataUrl) {
          await invoke<string>('save_data_url_to_desktop', { fileName, dataUrl: message.dataUrl, operationId });
        } else {
          throw new Error('The completed file is not available locally.');
        }
      } else {
        const targetPath = await saveDialog({ title: t('saveAs'), defaultPath: fileName });
        if (!targetPath) {
          setFileSaveProgress(null);
          return;
        }
        if (message.localPath) {
          await invoke<string>('save_received_file_as', {
            sourcePath: message.localPath,
            targetPath,
            originalName: fileName,
            operationId,
            overwrite: true
          });
        } else if (message.dataUrl) {
          await invoke<string>('save_data_url_as', {
            dataUrl: message.dataUrl,
            targetPath,
            originalName: fileName,
            operationId,
            overwrite: true
          });
        } else {
          throw new Error('The completed file is not available locally.');
        }
      }
      showToast(t('fileSaved'));
      setFileContextMenu(null);
    } catch (error) {
      const messageText = String((error as Error)?.message || error || t('fileSaveFailed'));
      addLog(`File save failed: ${messageText}`, 'error');
      showToast(`${t('fileSaveFailed')}: ${messageText}`);
    } finally {
      window.setTimeout(() => setFileSaveProgress((current) => current?.operationId === operationId ? null : current), 800);
    }
  }

  function showError(message: string) {
    addLog(message, 'error');
    displayToast(message);
  }

  async function refreshRecoverableRecordings() {
    try {
      setRecoverableScreenRecordings(await listRecoverableScreenRecordings());
    } catch (error) {
      addLog(`Screen recorder recovery scan: ${String((error as Error)?.message || error)}`, 'error');
    }
  }

  async function restoreScreenRecorderOutputDevice(): Promise<void> {
    const prior = screenRecorderPriorOutputDeviceRef.current;
    screenRecorderPriorOutputDeviceRef.current = null;
    if (prior === null || !roomRef.current) return;
    try {
      await roomRef.current.setVoiceOutputDevice(prior || undefined);
      addLog(`[recording:audio-route] restored call output device ${prior || 'default'}`, 'info');
    } catch (error) {
      addLog(`[recording:audio-route] could not restore call output device: ${String((error as Error)?.message || error)}`, 'error');
    }
  }

  function configureScreenRecorderController(): ScreenRecorderController {
    if (!screenRecorderControllerRef.current) screenRecorderControllerRef.current = new ScreenRecorderController();
    screenRecorderControllerRef.current.setCallbacks({
      onState: setScreenRecorderState,
      onBytes: setScreenRecorderBytes,
      onInfo: setScreenRecorderInfo,
      onSaved: (result) => {
        setScreenRecorderSavedPath(result.path);
        setScreenRecorderBytes(result.size);
        setScreenRecorderFinalization(result.finalizingMp4 ? t('recorderFinalizationSafe') : '');
        addLog(`${t('screenRecorderSaved')}: ${result.path}`, 'info');
        refreshRecoverableRecordings().catch(() => undefined);
      },
      onAudioLevels: setScreenRecorderLevels,
      onFinalizationStage: (stage, message) => {
        const detail = message || t('screenRecorderFinalizingMp4');
        setScreenRecorderFinalization(detail);
        addLog(`[recording:${stage}] ${detail}`, 'info');
      },
      onError: (message) => {
        setScreenRecorderError(message);
        addLog(`Screen recorder: ${message}`, 'error');
        refreshRecoverableRecordings().catch(() => undefined);
      }
    });
    return screenRecorderControllerRef.current;
  }

  async function startScreenRecording(overrideSettings?: ScreenRecorderSettings, resumeSessionId = '', sourceOverride?: MediaStream | null) {
    const source = sourceOverride || localScreenStream || roomRef.current?.getLocalScreenStream() || null;
    if (!source || !source.getVideoTracks().some((track) => track.readyState === 'live')) {
      showToast(t('screenRecorderNeedsStream'));
      return;
    }
    const controller = configureScreenRecorderController();
    if (!['idle', 'error'].includes(controller.getState())) return;
    screenRecorderAutoStreamIdRef.current = source.id || source.getVideoTracks()[0]?.id || 'screen';
    const recorderSettings = overrideSettings || settings?.screenRecorder || screenRecorderDraft || DEFAULT_SCREEN_RECORDER;
    setScreenRecorderError('');
    setScreenRecorderSavedPath('');
    setScreenRecorderBytes(0);
    setScreenRecorderElapsed(0);
    try {
      // Mic Test intentionally plays the microphone through the speakers. Stop it before
      // recording so the new direct microphone track is not captured twice.
      if (micTestActive) {
        stopMicTest();
        await invoke('native_voice_stop_mic_test').catch(() => undefined);
      }
      const requestedOutputDevice = recorderSettings.outputDeviceId || settings?.audioOutputId || '';
      const currentOutputDevice = settings?.audioOutputId || '';
      if (roomRef.current && requestedOutputDevice !== currentOutputDevice) {
        screenRecorderPriorOutputDeviceRef.current = currentOutputDevice;
        await roomRef.current.setVoiceOutputDevice(requestedOutputDevice || undefined);
        addLog(`[recording:audio-route] member output device set to ${requestedOutputDevice || 'default'}`, 'info');
      }

      const info = await controller.start(
        source,
        recorderSettings,
        Boolean(settings?.lowPcMode || voicePressure !== 'normal'),
        resumeSessionId,
        {
          inputDeviceId: recorderSettings.micDeviceId || settings?.audioInputId || undefined,
          outputDeviceId: recorderSettings.outputDeviceId || settings?.audioOutputId || undefined,
          voiceEnhanceEnabled: settings?.voiceEnhanceEnabled ?? true
        }
      );
      setScreenRecorderInfo(info);
      screenRecorderResumeSessionRef.current = resumeSessionId;
      if (recorderSettings.includeAudio && info.audioBitrate <= 0) showToast(t('screenRecorderAudioUnavailable'));
      addLog(`${resumeSessionId ? t('screenRecorderRecoveryStarted') : t('screenRecorderRecording')} ${info.width}x${info.height}@${Math.round(info.recordingFps)} ${info.codecLabel}`, 'info');
      await refreshRecoverableRecordings();
    } catch (error) {
      const message = String((error as Error)?.message || error || t('screenRecorderSaveFailed'));
      setScreenRecorderError(message);
      setScreenRecorderState('error');
      showError(`${t('screenRecorderSaveFailed')}: ${message}`);
      await restoreScreenRecorderOutputDevice();
      await refreshRecoverableRecordings();
    }
  }

  function pauseScreenRecording() {
    configureScreenRecorderController().pause();
  }

  function resumeScreenRecording() {
    configureScreenRecorderController().resume();
  }

  async function stopScreenRecording(showSavedToast = true) {
    const controller = screenRecorderControllerRef.current;
    if (!controller || !['recording', 'paused', 'starting', 'stopping'].includes(controller.getState())) {
      await restoreScreenRecorderOutputDevice();
      return null;
    }
    try {
      const result = await controller.stop();
      screenRecorderResumeSessionRef.current = '';
      if (result && showSavedToast) showToast(`${t('screenRecorderSaved')}: ${result.path}`);
      await refreshRecoverableRecordings();
      return result;
    } catch (error) {
      const message = String((error as Error)?.message || error || t('screenRecorderSaveFailed'));
      setScreenRecorderError(message);
      showError(`${t('screenRecorderSaveFailed')}: ${message}`);
      await refreshRecoverableRecordings();
      return null;
    } finally {
      await restoreScreenRecorderOutputDevice();
    }
  }

  async function saveScreenRecorderSettings() {
    if (!settings) return;
    const next = { ...settings, screenRecorder: { ...screenRecorderDraft } };
    await updateSettings(next);
    setDraftSettings((current) => current ? { ...current, screenRecorder: { ...screenRecorderDraft } } : current);
    showToast(t('screenRecorderSettingsSaved'));
  }

  async function openScreenRecorderPanel() {
    setScreenRecorderDraft({ ...(settingsForm.screenRecorder || DEFAULT_SCREEN_RECORDER) });
    setScreenRecorderOpen(true);
    prepareScreenRecorderDependencies().then(setScreenRecorderDependency).catch(() => undefined);
    await refreshRecoverableRecordings();
  }

  async function openScreenRecorderRecoveryPanel() {
    await refreshRecoverableRecordings();
    setScreenRecorderRecoveryOpen(true);
  }

  async function toggleScreenRecorderToolbar() {
    const controller = screenRecorderControllerRef.current;
    const active = controller && ['recording', 'paused', 'starting', 'stopping'].includes(controller.getState());
    if (active) {
      await stopScreenRecording(true);
      return;
    }
    if (screenRecorderArmed) return;
    screenRecorderManualStartRef.current = true;
    setScreenRecorderArmed(true);
    try {
      let source = localScreenStream || roomRef.current?.getLocalScreenStream() || null;
      if (!screenSharing || !source) source = await startScreenShareOnly();
      if (!source) throw new Error(t('screenRecorderNeedsStream'));
      await startScreenRecording(settings?.screenRecorder || DEFAULT_SCREEN_RECORDER, '', source);
    } catch (error) {
      const message = String((error as Error)?.message || error || t('screenRecorderSaveFailed'));
      setScreenRecorderError(message);
      showError(message);
    } finally {
      screenRecorderManualStartRef.current = false;
      setScreenRecorderArmed(false);
    }
  }

  async function resumeRecoverableRecording(recording: RecoverableScreenRecording) {
    if (screenRecorderRecoveryBusy) return;
    setScreenRecorderRecoveryBusy(recording.sessionId);
    screenRecorderManualStartRef.current = true;
    setScreenRecorderArmed(true);
    try {
      let source = localScreenStream || roomRef.current?.getLocalScreenStream() || null;
      if (!screenSharing || !source) source = await startScreenShareOnly();
      if (!source) throw new Error(t('screenRecorderNeedsStream'));
      setScreenRecorderRecoveryOpen(false);
      await startScreenRecording(settings?.screenRecorder || DEFAULT_SCREEN_RECORDER, recording.sessionId, source);
      showToast(t('screenRecorderRecoveryStarted'));
    } catch (error) {
      const message = String((error as Error)?.message || error || t('screenRecorderRepairFailed'));
      showError(`${t('screenRecorderRepairFailed')}: ${message}`);
    } finally {
      screenRecorderManualStartRef.current = false;
      setScreenRecorderArmed(false);
      setScreenRecorderRecoveryBusy('');
    }
  }

  async function finalizeRecoverableRecording(recording: RecoverableScreenRecording) {
    if (screenRecorderRecoveryBusy) return;
    setScreenRecorderRecoveryBusy(recording.sessionId);
    setScreenRecorderState('stopping');
    try {
      const result = await finalizeRecoverableScreenRecording(recording.sessionId);
      setScreenRecorderSavedPath(result.path);
      setScreenRecorderBytes(result.size);
      showToast(`${t('screenRecorderRecoverySaved')}: ${result.path}`);
      await refreshRecoverableRecordings();
      if (recoverableScreenRecordings.length <= 1) setScreenRecorderRecoveryOpen(false);
    } catch (error) {
      const message = String((error as Error)?.message || error || t('screenRecorderRepairFailed'));
      showError(`${t('screenRecorderRepairFailed')}: ${message}`);
    } finally {
      setScreenRecorderState('idle');
      setScreenRecorderRecoveryBusy('');
    }
  }

  async function openScreenRecorderFolder() {
    try {
      const path = await openScreenRecordingsFolder();
      setScreenRecorderSavedPath(path);
    } catch (error) {
      const message = String((error as Error)?.message || error || t('screenRecorderSaveFailed'));
      showError(message);
    }
  }

  async function downloadErrorLog() {
    const lines = [...errorLog].reverse().map((entry) => `[${new Date(entry.at).toLocaleString()}] ${entry.level.toUpperCase()}\n${entry.message}`);
    const contents = lines.join('\n\n') || 'MHTalk log is empty.';
    const fileName = `MHTalk_${APP_VERSION}_log_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    try {
      const savedPath = await invoke<string | null>('save_text_file_with_dialog', { defaultName: fileName, contents });
      if (savedPath) showToast(`${t('logDownloaded')} ${savedPath}`);
    } catch (error) {
      addLog(String((error as Error)?.message || error || 'Log save dialog failed'), 'error');
      const blob = new Blob([contents], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showToast(t('logDownloaded'));
    }
  }


  async function checkWithTimeout() {
    const timeoutMs = 9000;
    let timeoutId = 0;
    try {
      return await Promise.race([
        check(),
        new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(() => reject(new Error('Update check timed out, continuing offline.')), timeoutMs);
        })
      ]);
    } finally {
      if (timeoutId) window.clearTimeout(timeoutId);
    }
  }

  function continueOfflineFromUpdateGate() {
    addLog(t('updateTimeout'), 'info');
    setRequiredUpdate(null);
    setUpdateProgress('');
    setUpdateGateChecked(true);
    setUpdateBusy(false);
  }

  async function installRequiredUpdate(updateArg?: any) {
    if (updateBusy && !updateArg) return;
    setUpdateBusy(true);
    setUpdateGateChecked(false);
    setUpdateProgress(t('updateInstalling'));
    try {
      const update = updateArg || pendingUpdateRef.current || await checkWithTimeout();
      if (!update) {
        setRequiredUpdate(null);
        setUpdateProgress('');
        setUpdateGateChecked(true);
        showToast(t('updateNone'));
        setUpdateBusy(false);
        return;
      }

      pendingUpdateRef.current = update;
      setRequiredUpdate({ version: String(update.version || ''), notes: String(update.body || '').trim() });
      let downloaded = 0;
      let contentLength = 0;
      await update.downloadAndInstall((event: any) => {
        if (event.event === 'Started') {
          contentLength = event.data.contentLength || 0;
          setUpdateProgress(contentLength > 0 ? `${t('updateProgress')}: 0%` : t('updateInstalling'));
        }
        if (event.event === 'Progress') {
          downloaded += event.data.chunkLength || 0;
          if (contentLength > 0) setUpdateProgress(`${t('updateProgress')}: ${Math.min(100, Math.round((downloaded / contentLength) * 100))}%`);
        }
        if (event.event === 'Finished') setUpdateProgress(t('updateReady'));
      });

      showToast(t('updateReady'));
      await relaunch();
    } catch (error) {
      const message = String((error as Error)?.message || error || 'Update error');
      addLog(message, 'error');
      showToast(t('updateFailed'));
      setUpdateProgress(t('updateFailed'));
      setUpdateGateChecked(true);
      setUpdateBusy(false);
    }
  }

  async function checkForUpdates(manual = false) {
    if (updateBusy) return;
    setUpdateBusy(true);
    if (manual) setUpdateProgress(t('checkingUpdates'));
    try {
      const update = await checkWithTimeout();
      if (!update) {
        pendingUpdateRef.current = null;
        setRequiredUpdate(null);
        setUpdateProgress('');
        setUpdateGateChecked(true);
        setUpdateBusy(false);
        if (manual) showToast(t('updateNone'));
        return;
      }

      const notes = String(update.body || '').trim();
      pendingUpdateRef.current = update;
      setRequiredUpdate({ version: String(update.version || ''), notes });
      setUpdateProgress(manual ? t('updateInstalling') : t('updateAutoInstalling'));
      setUpdateBusy(false);
      await installRequiredUpdate(update);
    } catch (error) {
      const message = String((error as Error)?.message || error || 'Update error');
      const isTimeout = message.toLowerCase().includes('timed out');
      addLog(isTimeout ? t('updateTimeout') : message, isTimeout ? 'info' : 'error');
      if (manual) showToast(isTimeout ? t('updateTimeout') : t('updateFailed'));
      setRequiredUpdate(null);
      setUpdateProgress(isTimeout ? t('updateTimeout') : '');
      setUpdateGateChecked(true);
      setUpdateBusy(false);
    }
  }

  function stopMicTest() {
    try { micTestUnlistenRef.current?.(); } catch { /* ignore */ }
    try { micTestErrorUnlistenRef.current?.(); } catch { /* ignore */ }
    micTestUnlistenRef.current = null;
    micTestErrorUnlistenRef.current = null;
    invoke('native_voice_stop_mic_test').catch(() => undefined);
    setMicTestActive(false);
    setMicTestLevel(0);
  }

  async function startMicTest() {
    if (!settings) return;
    stopMicTest();
    try {
      micTestUnlistenRef.current = await listen<number>('mhlko://native-voice-mic-test-level', (event) => {
        setMicTestLevel(Math.min(1, Math.max(0, Number(event.payload || 0) * 4)));
      });
      micTestErrorUnlistenRef.current = await listen<string>('mhlko://native-voice-mic-test-error', (event) => {
        addLog(String(event.payload || 'Native mic test error'), 'error');
      });
      await invoke('native_voice_start_mic_test', { inputDeviceId: settings.audioInputId || null, outputDeviceId: settings.audioOutputId || null, inputDeviceLabel: selectedInputLabel(settings.audioInputId), outputDeviceLabel: selectedOutputLabel(settings.audioOutputId) });
      setMicTestActive(true);
    } catch (error) {
      const message = String((error as Error)?.message || error || 'Mic test error');
      addLog(message, 'error');
      showToast(t('micTestFailed'));
      stopMicTest();
    }
  }

  async function toggleMicTest() {
    if (micTestActive) stopMicTest();
    else await startMicTest();
  }

  function playTone(kind: 'screen-on' | 'screen-off' | 'join' | 'leave') {
    // 0.6.8: UI notification sounds are routed through the Native Voice Engine too.
    // No oscillator/AudioContext output is used in WebView.
    invoke('native_voice_play_tone', { kind }).catch(() => undefined);
  }

  async function requestNotificationsIfNeeded(enabled: boolean) {
    if (!enabled || !('Notification' in window)) return;
    if (Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch { /* ignore */ }
    }
  }

  function notifyIncoming(message: ChatMessage) {
    if (!settings?.notificationsEnabled || windowFocused) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const title = message.privateFrom ? `${message.senderName} • ${t('privateLabel')}` : message.senderName || 'MHTalk';
    const body = message.kind === 'text' ? message.body : message.fileName || message.body || 'New message';
    try { new Notification(title, { body, silent: false }); } catch { /* desktop notification unsupported */ }
  }

  function makeReplyPreview(message: ChatMessage): Pick<ChatMessage, 'id' | 'body' | 'senderName'> {
    return {
      id: message.id,
      senderName: message.senderName,
      body: message.kind === 'text' ? message.body : (message.fileName || message.body || 'media')
    };
  }


  function messagePreviewText(message: ChatMessage) {
    return message.kind === 'text' ? message.body : (message.fileName || message.body || t('mediaLabel'));
  }

  function statusFromReceipts(targetCount = 0, deliveredTo: string[] = [], seenBy: string[] = []): ChatMessage['deliveryStatus'] {
    const total = Math.max(0, targetCount);
    if (total <= 0) return 'sent';
    if (seenBy.length >= total) return 'seen';
    if (deliveredTo.length >= total) return 'delivered';
    return 'sent';
  }

  function withReceipt(message: ChatMessage, peerId: string, status: 'delivered' | 'seen'): ChatMessage {
    if (message.sender !== 'me') return message;
    const deliveredTo = new Set(message.deliveredTo || []);
    const seenBy = new Set(message.seenBy || []);
    if (status === 'delivered' || status === 'seen') deliveredTo.add(peerId);
    if (status === 'seen') seenBy.add(peerId);
    const nextDelivered = [...deliveredTo];
    const nextSeen = [...seenBy];
    return {
      ...message,
      deliveredTo: nextDelivered,
      seenBy: nextSeen,
      deliveryStatus: statusFromReceipts(message.targetCount || nextDelivered.length || 0, nextDelivered, nextSeen)
    };
  }

  function messageStatusText(message: ChatMessage) {
    const status = message.deliveryStatus || 'sent';
    if (status === 'sending') return t('messageSending');
    if (status === 'delivered') return t('messageDelivered');
    if (status === 'seen') return t('messageSeen');
    return t('messageSent');
  }

  function markOutgoingSentSoon(messageId: string) {
    window.setTimeout(() => {
      setMessages((current) => {
        const next = current.map((message) => message.id === messageId && message.deliveryStatus === 'sending' ? { ...message, deliveryStatus: 'sent' as const } : message);
        const updated = next.find((message) => message.id === messageId);
        if (updated && settings?.saveChat) saveMessage(updated).catch(() => undefined);
        return next;
      });
    }, 350);
  }

  function sendSeenReceiptFor(message: ChatMessage) {
    if (message.sender !== 'peer' || !message.peerId || message.deletedAt) return;
    roomRef.current?.sendSeenReceipt(message.id, message.peerId);
  }


  useEffect(() => {
    if (!windowFocused || !roomRef.current || !roomId) return;
    const candidates = messages.filter((message) => message.sender === 'peer' && message.peerId && !message.deletedAt && !seenReceiptSentRef.current.has(message.id));
    if (!candidates.length) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.55) continue;
        const id = (entry.target as HTMLElement).dataset.messageId || '';
        if (!id || seenReceiptSentRef.current.has(id)) continue;
        const message = messages.find((item) => item.id === id);
        if (!message) continue;
        seenReceiptSentRef.current.add(id);
        sendSeenReceiptFor(message);
      }
    }, { threshold: [0.55] });
    for (const message of candidates) {
      const node = messageRefs.current[message.id];
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [windowFocused, messages, roomId]);

  function scrollToMessage(messageId?: string) {
    if (!messageId) return;
    const node = messageRefs.current[messageId];
    if (!node) {
      showToast(t('originalMessageMissing'));
      return;
    }
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedMessageId(messageId);
    window.setTimeout(() => setHighlightedMessageId((current) => current === messageId ? '' : current), 1800);
  }

  function handleRemoteTyping(peerId: string, senderName: string, active: boolean) {
    if (!peerId) return;
    window.clearTimeout(typingTimersRef.current[peerId]);
    if (!active) {
      setTypingUsers((current) => { const next = { ...current }; delete next[peerId]; return next; });
      return;
    }
    setTypingUsers((current) => ({ ...current, [peerId]: senderName }));
    typingTimersRef.current[peerId] = window.setTimeout(() => {
      setTypingUsers((current) => { const next = { ...current }; delete next[peerId]; return next; });
    }, 2600);
  }

  function resizeComposerTextarea(textarea: HTMLTextAreaElement | null) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    const lineHeight = Number.parseFloat(window.getComputedStyle(textarea).lineHeight || '20') || 20;
    const maxHeight = Math.round(lineHeight * 3 + 18);
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }

  function handleDraftChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const value = event.target.value;
    setDraft(value);
    resizeComposerTextarea(event.currentTarget);
    if (!roomRef.current || !roomId || editingMessage) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current > 900) {
      roomRef.current.sendTyping(Boolean(value.trim()), privateTarget || undefined);
      lastTypingSentRef.current = now;
    }
    if (typingStopTimerRef.current) window.clearTimeout(typingStopTimerRef.current);
    typingStopTimerRef.current = window.setTimeout(() => {
      roomRef.current?.sendTyping(false, privateTarget || undefined);
    }, 1400);
  }

  function beginEditMessage(message: ChatMessage) {
    if (message.sender !== 'me' || message.kind !== 'text') return;
    setEditingMessage(message);
    setReplyTo(null);
    setDraft(message.body);
  }

  function cancelEdit() {
    setEditingMessage(null);
    setDraft('');
  }

  async function makeWaveform(blob: Blob, bars = 36): Promise<number[]> {
    try {
      const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) throw new Error('no-audio-context');
      const ctx = new AudioContextClass();
      const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
      const data = buffer.getChannelData(0);
      const block = Math.max(1, Math.floor(data.length / bars));
      const result: number[] = [];
      for (let i = 0; i < bars; i += 1) {
        let sum = 0;
        const start = i * block;
        for (let j = 0; j < block && start + j < data.length; j += 1) sum += Math.abs(data[start + j]);
        result.push(Math.min(1, Math.max(0.08, (sum / block) * 4)));
      }
      await ctx.close().catch(() => undefined);
      return result;
    } catch {
      addLog('Voice waveform analysis failed; using deterministic low fallback bars.', 'info');
      return Array.from({ length: bars }, () => 0.22);
    }
  }

  async function updateSettings(next: AppSettings) {
    setSettingsState(next);
    await saveSettings(next);
    if (next.notificationsEnabled) await requestNotificationsIfNeeded(true);
  }

  function updateDraftSettings(patch: Partial<AppSettings>) {
    setDraftSettings((current) => ({ ...(current || settings || DEFAULT_SETTINGS), ...patch }));
  }

  async function applySettingsChanges() {
    if (!draftSettings) return;
    const next: AppSettings = {
      ...draftSettings,
      // Hotkeys are saved immediately from their dedicated editor. Preserve the latest
      // committed values so an older settings draft cannot silently overwrite them.
      hotkeys: { ...(settings?.hotkeys || draftSettings.hotkeys) }
    };
    if (!availableQualityOptions.includes(next.screenQuality)) next.screenQuality = availableQualityOptions[0] || 'auto-max';
    if (!availableFpsOptions.includes(next.screenFps)) next.screenFps = availableFpsOptions.includes(60) ? 60 : availableFpsOptions[0] || 60;
    await updateSettings(next);
    setDraftSettings({ ...next });
    showToast(t('settingsSaved'));
  }

  async function toggleVoiceEnhance() {
    if (!settings) return;
    const enabled = !settings.voiceEnhanceEnabled;
    try {
      const applied = await invoke<boolean>('native_voice_set_enhance_enabled', { enabled });
      await updateSettings({ ...settings, voiceEnhanceEnabled: applied });
      await roomRef.current?.setVoiceEnhanceEnabled(applied);
      const status = await invoke<VoiceEngineStatus>('voice_companion_status');
      setVoiceEngineStatus(status);
      showToast(applied ? t('voiceEnhanceEnabled') : t('voiceEnhanceDisabled'));
    } catch (error) {
      addLog(String((error as Error)?.message || error || 'Voice Enhance error'), 'error');
      showToast(t('voiceSolutionFailed'));
    }
  }

  async function persistHotkey(action: HotkeyAction, combo: string) {
    if (!settings) return;
    const normalized = normalizeHotkeyCombo(combo);
    const duplicate = (Object.entries(settings.hotkeys || {}) as Array<[HotkeyAction, string]>)
      .find(([otherAction, value]) => otherAction !== action && value && normalizeHotkeyCombo(value) === normalized);
    if (normalized && duplicate) {
      showToast(`${t('hotkeyDuplicate')}: ${displayHotkey(duplicate[1])}`);
      return;
    }

    const nextHotkeys = { ...(settings.hotkeys || {}), [action]: normalized };
    const next = { ...settings, hotkeys: nextHotkeys };
    await updateSettings(next);
    setDraftSettings((current) => current ? { ...current, hotkeys: { ...nextHotkeys } } : current);
    showToast(t('hotkeySaved'));
  }

  function clearHotkey(action: HotkeyAction) {
    if (!settings) return;
    persistHotkey(action, '').catch((error) => {
      addLog(`Hotkey clear failed: ${String((error as Error)?.message || error)}`, 'error');
    });
    if (learningHotkey === action) setLearningHotkey(null);
  }

  async function updateProfile(next: UserProfile) {
    setProfile(next);
    await saveProfile(next);
    roomRef.current?.updateProfile(next);
  }

  function defaultVolume(): PeerVolume { return { voice: 1, screen: 1, voiceMuted: false, screenMuted: false }; }

  function ensurePeerVolume(peerId: string) {
    setPeerVolumes((current) => current[peerId] ? current : { ...current, [peerId]: defaultVolume() });
  }

  async function shouldAutoStartMicForRoom(): Promise<boolean> {
    try {
      if (window.localStorage.getItem('mhlko.micAutoStartGranted') === 'true') return true;
      const permissions = navigator.permissions as Permissions & { query?: (descriptor: PermissionDescriptor) => Promise<PermissionStatus> };
      if (permissions?.query) {
        const status = await permissions.query({ name: 'microphone' as PermissionName });
        return status.state === 'granted';
      }
    } catch { /* permission query is not supported in every WebView */ }
    return false;
  }

  function rememberMicAutoStartSuccess() {
    try { window.localStorage.setItem('mhlko.micAutoStartGranted', 'true'); } catch { /* ignore */ }
  }

  async function chooseRoomMic(enabled: boolean) {
    setMicJoinPromptOpen(false);
    if (!enabled) {
      roomRef.current?.setMicEnabled(false);
      setMicEnabled(false);
      setVoiceActive(false);
      addLog('User entered room with microphone muted', 'info');
      return;
    }
    if (!roomRef.current || !activeSettings) return;
    try {
      await startRoomVoice(roomRef.current);
      rememberMicAutoStartSuccess();
      setVoiceActive(true);
      setMicEnabled(true);
      roomRef.current.setMicEnabled(true);
      addLog('User enabled microphone from room entry prompt', 'info');
    } catch {
      showToast(t('micPermission'));
      setMicEnabled(false);
      setVoiceActive(false);
    }
  }

  function syncHistoryToPeer(peerId: string) {
    if (!roomRef.current || !settings?.showHistoryForNewMembers || !isRoomOwnerRef.current) return;
    const items = messagesRef.current.filter((message) => message.sender !== 'system' && !message.deletedAt).slice(-80);
    let sentCount = 0;
    for (const message of items) {
      if (roomRef.current.sendExistingMessageToPeer(message, peerId)) sentCount += 1;
    }
    if (sentCount > 0) addLog(`${t('historySyncedToNewMember')} ${sentCount}`, 'info');
  }

  useEffect(() => {
    // Member voice is rendered only inside the isolated MHTalkVoice process.
    for (const [peerId, volume] of Object.entries(peerVolumes)) {
      if (!peerId || peerId === localPeerId) continue;
      const voiceVolume = Number.isFinite(volume.voice) ? Math.min(2, Math.max(0, volume.voice)) : 1;
      roomRef.current?.setPeerVoiceVolume(peerId, voiceVolume, Boolean(volume.voiceMuted)).catch(() => undefined);
    }
  }, [peerVolumes, localPeerId]);

  async function openRoom(id: string) {
    if (!profile || !activeSettings || !settings) return;
    setBusy(true);
    try {
      await stopScreenRecording(false);
      roomRef.current?.close();
      const cleanId = normalizeRoomId(id);
      setRoomId(cleanId);
      setMessages(settings.saveChat ? await loadMessages(cleanId) : []);
      setPeers({});
      setPeerMedia({});
      setScreenStreams({});
      setPeerVolumes({});
      setActivePeerId('');
      setPrivateTarget('');
      setReplyTo(null);
      setEditingMessage(null);
      setIsRoomOwner(false);
      setOwnerPeerId('');
      setTypingUsers({});
      setHighlightedMessageId('');
      setPendingAttachments([]);
      pendingAttachmentKeysRef.current.clear();
      setBannedMembers([]);
      setBanModalOpen(false);
      setSettingsOpen(false);
      setJoinRequests({});
      setJoinRequestsOpen(false);
      setRoomRoles({});
      setPendingVoice(null);
      setChatOverlayOpen(false);
      setAdminMutedPeers({});
      setGlobalMuteActive(false);
      globalMuteActiveRef.current = false;
      globalMuteSnapshotRef.current = null;
      forcedMutedByAdminRef.current = false;
      preForcedLocalMicEnabledRef.current = null;
      setHotkeysOpen(false);
      setErrorLogOpen(false);
      previousPeerIdsRef.current = new Set();
      closedStreamPeersRef.current = new Set();
      autoOpenedJoinRequestIdsRef.current = new Set();
      seenReceiptSentRef.current = new Set();
      historySyncedPeerIdsRef.current = new Set();
      micPromptShownForRoomRef.current = false;
      cameraWithStreamArmedRef.current = false;
      setCameraWithStreamArmed(false);
      setMicJoinPromptOpen(false);
      setCameraOpen(false);
      setCameraMode('camera-only');
      setCameraStream(null);
      setLocalScreenStream(null);
      setCameraStreams({});
      setScreenSharing(false);
      setVoiceActive(false);
      setMicEnabled(false);

      let room: RealtimeRoom;
      const openMicPromptOnce = () => {
        if (micPromptShownForRoomRef.current) return;
        micPromptShownForRoomRef.current = true;
        setMicJoinPromptOpen(true);
        addLog('Room microphone prompt opened', 'info');
      };

      room = new RealtimeRoom({
        roomId: cleanId,
        signalingUrl: activeSettings.signalingUrl,
        profile,
        callbacks: {
          onState: (state, label) => {
            setConnection(state);
            if (label) setConnectionLabel(label);
          },
          onMessage: async (message) => {
            setMessages((current) => [...current, message]);
            notifyIncoming(message);
            if (windowFocused) window.setTimeout(() => sendSeenReceiptFor(message), 80);
            if (settings.saveChat) await saveMessage(message);
          },
           onPeers: (nextPeers) => {
            const previous = previousPeerIdsRef.current;
            const mapped: Record<string, PeerProfile> = {};
            for (const peer of nextPeers) mapped[peer.peerId] = peer;
            const nextIds = new Set(nextPeers.map((peer) => peer.peerId));
            if (previous.size > 0) {
              if (nextPeers.some((peer) => !previous.has(peer.peerId))) playTone('join');
              if ([...previous].some((peerId) => !nextIds.has(peerId))) playTone('leave');
            }
            previousPeerIdsRef.current = nextIds;
            setPeers(mapped);
            nextPeers.forEach((peer) => {
              ensurePeerVolume(peer.peerId);
              if (globalMuteActiveRef.current && !previous.has(peer.peerId)) {
                room.mutePeerForRoom(peer.peerId);
                setAdminMutedPeers((current) => ({ ...current, [peer.peerId]: true }));
                setPeerMedia((current) => ({ ...current, [peer.peerId]: { ...(current[peer.peerId] || { screenSharing: false, micEnabled: true, cameraSharing: false }), micEnabled: false } }));
                addLog(`New member joined during global mute and was muted: ${peer.displayName}`, 'info');
              }
              if (!previous.has(peer.peerId) && settings.showHistoryForNewMembers && isRoomOwnerRef.current && !historySyncedPeerIdsRef.current.has(peer.peerId)) {
                historySyncedPeerIdsRef.current.add(peer.peerId);
                window.setTimeout(() => syncHistoryToPeer(peer.peerId), 900);
              }
             });
           },
          onProfileAssetAccess: (access) => {
            lastPublishedProfileAssetRef.current = '';
            setProfileAssetAccess(access);
          },
          onProfileAssetsStale: () => {
            queryClient.invalidateQueries({ queryKey: ['profile-assets', cleanId] }).catch(() => undefined);
          },
           onRemoteStream: (peerId, streamType, stream) => {
            if (streamType === 'camera') {
              const hasLiveVideo = stream.getVideoTracks().some((track) => track.readyState === 'live');
              setCameraStreams((current) => {
                const next = { ...current };
                if (hasLiveVideo) next[peerId] = stream;
                else delete next[peerId];
                return next;
              });
              if (!hasLiveVideo && activePeerId === peerId && activeMediaMode === 'camera') setActivePeerId('');
            } else {
              const hasLiveVideo = stream.getVideoTracks().some((track) => track.readyState === 'live');
              setStreamRefreshTokens((current) => ({ ...current, [peerId]: (current[peerId] || 0) + 1 }));
              setScreenStreams((current) => {
                const next = { ...current };
                if (hasLiveVideo) next[peerId] = stream;
                else delete next[peerId];
                return next;
              });
              if (hasLiveVideo) addLog(t('streamViewerOpened') + `: available ${peerId}`, 'info');
              else setActivePeerId((current) => current === peerId && activeMediaMode === 'screen' ? '' : current);
            }
          },
          onError: (message) => showError(TEXT[lang]?.[message] ?? message),
          onLog: (message, level = 'info') => addLog(message, level),
          onLocalMedia: (media) => {
            if (typeof media.screenSharing === 'boolean') {
              setScreenSharing(media.screenSharing);
              setLocalScreenStream(media.screenSharing ? room.getLocalScreenStream() || null : null);
              addLog(media.screenSharing ? t('streamStarted') : t('streamEnded'), 'info');
            }
            if (typeof media.cameraSharing === 'boolean') setCameraOpen(media.cameraSharing);
            if (typeof media.micEnabled === 'boolean') setMicEnabled(media.micEnabled);
          },
          onVoiceActivity: (peerId, speaking) => updateSpeaking(peerId, speaking),
          onMedia: (peerId, media) => {
            setPeerMedia((current) => {
              const previous = current[peerId];
              const nextScreenSharing = typeof media.screenSharing === 'boolean' ? media.screenSharing : previous?.screenSharing ?? false;
              const nextCameraSharing = typeof media.cameraSharing === 'boolean' ? media.cameraSharing : previous?.cameraSharing ?? false;
              if (typeof media.screenSharing === 'boolean' && previous && previous.screenSharing !== nextScreenSharing) playTone(nextScreenSharing ? 'screen-on' : 'screen-off');
              return {
                ...current,
                [peerId]: {
                  micEnabled: typeof media.micEnabled === 'boolean' ? media.micEnabled : previous?.micEnabled ?? true,
                  screenSharing: nextScreenSharing,
                  cameraSharing: nextCameraSharing
                }
              };
            });
            if (media.screenSharing === false) {
              setScreenStreams((current) => { const next = { ...current }; delete next[peerId]; return next; });
            setCameraStreams((current) => { const next = { ...current }; delete next[peerId]; return next; });
              setStreamRefreshTokens((current) => { const next = { ...current }; delete next[peerId]; return next; });
              closedStreamPeersRef.current.delete(peerId);
              setActivePeerId((current) => current === peerId ? '' : current);
              addLog(`Remote stream ended: ${peers[peerId]?.displayName || peerId}`, 'info');
            }
            if (media.screenSharing === true) addLog(`Remote stream available: ${peers[peerId]?.displayName || peerId}`, 'info');
            if (media.cameraSharing === false) {
              setCameraStreams((current) => { const next = { ...current }; delete next[peerId]; return next; });
              if (activePeerId === peerId && activeMediaMode === 'camera') setActivePeerId('');
              addLog(`Remote camera ended: ${peers[peerId]?.displayName || peerId}`, 'info');
            }
            if (media.cameraSharing === true) addLog(`Remote camera available: ${peers[peerId]?.displayName || peerId}`, 'info');
          },
          onPeerLeft: (peerId) => {
            if (previousPeerIdsRef.current.delete(peerId)) playTone('leave');
            closedStreamPeersRef.current.delete(peerId);
            setPeers((current) => { const next = { ...current }; delete next[peerId]; return next; });
            setPeerMedia((current) => { const next = { ...current }; delete next[peerId]; return next; });
            setScreenStreams((current) => { const next = { ...current }; delete next[peerId]; return next; });
            setCameraStreams((current) => { const next = { ...current }; delete next[peerId]; return next; });
            updateSpeaking(peerId, false);
            setSpeakingPeers((current) => { const next = { ...current }; delete next[peerId]; return next; });
            setActivePeerId((current) => current === peerId ? '' : current);
            setPrivateTarget((current) => current === peerId ? '' : current);
            setAdminMutedPeers((current) => { const next = { ...current }; delete next[peerId]; return next; });
            setSpeakRequests((current) => { const next = { ...current }; delete next[peerId]; return next; });
            handleRemoteTyping(peerId, '', false);
          },
          onMessageEdit: (messageId, body, editedAt) => {
            setMessages((current) => {
              const next = current.map((message) => message.id === messageId ? { ...message, body, editedAt } : message);
              const updated = next.find((message) => message.id === messageId);
              if (updated && settings.saveChat) saveMessage(updated).catch(() => undefined);
              return next;
            });
          },
          onMessageDelete: (messageId, deletedAt) => {
            setMessages((current) => current.map((message) => message.id === messageId ? { ...message, body: '', dataUrl: undefined, deletedAt } : message));
            if (settings.saveChat) markMessageDeleted(messageId, deletedAt).catch(() => undefined);
          },
          onMessageReceipt: (messageId, peerId, status) => {
            setMessages((current) => {
              const next = current.map((message) => message.id === messageId ? withReceipt(message, peerId, status) : message);
              const updated = next.find((message) => message.id === messageId);
              if (updated && settings.saveChat) saveMessage(updated).catch(() => undefined);
              return next;
            });
          },
          onFileProgress: (patch) => {
            setMessages((current) => {
              const exists = current.some((message) => message.id === patch.id);
              const next = exists ? current.map((message) => message.id === patch.id ? { ...message, ...patch, sender: message.sender, senderName: patch.senderName || message.senderName, createdAt: message.createdAt || patch.createdAt } : message) : [...current, patch];
              const updated = next.find((message) => message.id === patch.id);
              if (updated && settings.saveChat) saveMessage(updated).catch(() => undefined);
              return next;
            });
          },
          onTyping: handleRemoteTyping,
          onOwner: (owner, ownerId) => {
            setIsRoomOwner(owner);
            setOwnerPeerId(ownerId);
            if (owner) {
              isRoomOwnerRef.current = true;
              setForcedMutedByAdmin(false);
              forcedMutedByAdminRef.current = false;
              preForcedLocalMicEnabledRef.current = null;
              addLog('Admin forced mute state cleared for owner', 'info');
            }
          },
          onRoles: (roles) => setRoomRoles(roles),
          onJoinRequest: (request) => {
            const requestKey = `${request.peerId}:${request.requestedAt}`;
            setJoinRequests((current) => ({ ...current, [request.peerId]: request }));
            if (!autoOpenedJoinRequestIdsRef.current.has(requestKey)) {
              autoOpenedJoinRequestIdsRef.current.add(requestKey);
              setJoinRequestsOpen(true);
              addLog(`Join request auto-opened: ${request.displayName}`, 'info');
            } else {
              addLog(`Join request kept pending: ${request.displayName}`, 'info');
            }
            showToast(`${t('joinRequests')}: ${request.displayName}`);
          },
          onJoinDecision: (accepted) => {
            showToast(accepted ? t('joinAccepted') : t('joinRejected'));
            if (accepted) openMicPromptOnce();
          },
          onKicked: () => {
            showToast(t('kickedOut'));
            leaveRoom(false).catch(() => undefined);
          },
          onAdminMuteAll: (fromPeerId) => {
            if (isRoomOwnerRef.current) {
              setForcedMutedByAdmin(false);
              forcedMutedByAdminRef.current = false;
              preForcedLocalMicEnabledRef.current = null;
              addLog('Mute All ignored for owner/admin', 'info');
              return;
            }
            if (!forcedMutedByAdminRef.current && preForcedLocalMicEnabledRef.current === null) preForcedLocalMicEnabledRef.current = micEnabledRef.current;
            setForcedMutedByAdmin(true);
            forcedMutedByAdminRef.current = true;
            room.setMicEnabled(false);
            setMicEnabled(false);
            updateSpeaking(localPeerId, false);
            showToast(t('mutedByAdmin'));
            addLog(`${t('mutedByAdmin')}: ${fromPeerId}`, 'info');
          },
          onAdminUnmuteAll: () => {
            const restore = preForcedLocalMicEnabledRef.current;
            preForcedLocalMicEnabledRef.current = null;
            setForcedMutedByAdmin(false);
            forcedMutedByAdminRef.current = false;
            if (restore !== null && voiceActiveRef.current) {
              room.setMicEnabled(restore);
              setMicEnabled(restore);
            }
            showToast(t('unmuteAllMembers'));
            addLog('Admin cleared forced mute and restored previous local mute state', 'info');
          },
          onAdminPeerMuteState: (peerId, muted) => {
            if (!peerId) return;
            setAdminMutedPeers((current) => {
              const next = { ...current };
              if (muted) next[peerId] = true;
              else delete next[peerId];
              return next;
            });
            setPeerMedia((current) => ({ ...current, [peerId]: { ...(current[peerId] || { screenSharing: false, micEnabled: true, cameraSharing: false }), micEnabled: !muted } }));
            addLog(`${muted ? 'Public admin mute' : 'Public admin unmute'}: ${peerId}`, 'info');
          },
          onRequestToSpeak: (request) => {
            if (!canModerate) return;
            setSpeakRequests((current) => ({ ...current, [request.peerId]: request }));
            setJoinRequestsOpen(true);
            playTone('join');
            showToast(`${t('requestToSpeak')}: ${request.displayName}`);
            addLog(`Member requested to speak: ${request.displayName}`, 'info');
          },
          onSpeakPermission: (allowed) => {
            if (allowed) {
              setForcedMutedByAdmin(false);
              showToast(t('adminAllowedSpeak'));
            } else {
              showToast(t('adminRejectedSpeak'));
            }
          },
          onVoiceProfile: (profileName) => {
            setVoiceProfile(profileName);
            addLog(`${t('voiceProfileChanged')}: ${profileName}`, 'info');
          },
          onVoicePressure: (level) => {
            setVoicePressure(level);
            if (level !== 'normal') addLog(`Voice priority protection active: ${level}`, 'info');
          },
          onBans: (members) => setBannedMembers(members)
        }
      });

      roomRef.current = room;
      (window as typeof window & { __MHTALK_RTC_DIAGNOSTICS__?: () => unknown }).__MHTALK_RTC_DIAGNOSTICS__ = () => room.getRtcDiagnosticsHistory();
      setLocalPeerId(room.getLocalPeerId());
      setMessages((current) => [...current, systemMessage(cleanId, t('roomOpened'))]);
      await room.connect();
    } finally {
      setBusy(false);
    }
  }

  async function createRoom() { await openRoom(generateRoomId()); }

  async function joinRoom() {
    const clean = normalizeRoomId(joinCode);
    if (!clean.startsWith('MHLKO-') || clean.length < 12) {
      showToast(t('invalidRoom'));
      return;
    }
    await openRoom(clean);
  }

  async function leaveRoom(ask = true) {
    if (ask && !window.confirm(t('confirmEndCall'))) return;
    await stopScreenRecording(true);
    await roomRef.current?.cleanDisconnect();
    roomRef.current = null;
    setRoomId('');
    setConnection('idle');
    setConnectionLabel('state_idle');
    setPeers({});
    setPeerMedia({});
    setScreenStreams({});
    setMessages([]);
    setVoiceActive(false);
    setMicEnabled(false);
    setScreenSharing(false);
    setActivePeerId('');
    setPrivateTarget('');
    setReplyTo(null);
    setEditingMessage(null);
    setLocalPeerId('');
    setMicJoinPromptOpen(false);
    setIsRoomOwner(false);
    setOwnerPeerId('');
    setTypingUsers({});
    setHighlightedMessageId('');
    setPendingAttachments([]);
    pendingAttachmentKeysRef.current.clear();
    setBannedMembers([]);
    setBanModalOpen(false);
    setJoinRequests({});
    setJoinRequestsOpen(false);
    setRoomRoles({});
    setPendingVoice(null);
    try { await chatOverlayWindowRef.current?.close(); } catch { /* ignore */ }
    chatOverlayWindowRef.current = null;
    setChatOverlayExternal(false);
    setChatOverlayOpen(false);
    setAdminMutedPeers({});
    setGlobalMuteActive(false);
    globalMuteActiveRef.current = false;
    globalMuteSnapshotRef.current = null;
    forcedMutedByAdminRef.current = false;
    preForcedLocalMicEnabledRef.current = null;
    setHotkeysOpen(false);
    setErrorLogOpen(false);
    previousPeerIdsRef.current = new Set();
    autoOpenedJoinRequestIdsRef.current = new Set();
    seenReceiptSentRef.current = new Set();
  }

  async function sendChat() {
    if (editingMessage) {
      const result = roomRef.current?.editMessage(editingMessage.id, draft, editingMessage.privateTo || undefined);
      if (!result) {
        showToast(t('chatDisconnected'));
        return;
      }
      setMessages((current) => {
        const next = current.map((message) => message.id === result.id ? { ...message, body: result.body, editedAt: result.editedAt } : message);
        const updated = next.find((message) => message.id === result.id);
        if (updated && settings?.saveChat) saveMessage(updated).catch(() => undefined);
        return next;
      });
      setDraft('');
      setEditingMessage(null);
      setShowEmoji(false);
      messageInputRef.current?.focus();
      return;
    }

    const hasText = Boolean(draft.trim());
    const hasFiles = pendingAttachments.length > 0;
    const hasVoice = Boolean(pendingVoice);
    if (!hasText && !hasFiles && !hasVoice) return;

    if (hasText) {
      const sent = roomRef.current?.sendChat(draft, privateTarget || undefined, replyTo ? makeReplyPreview(replyTo) : undefined);
      if (!sent) {
        showToast(t('chatDisconnected'));
        return;
      }
      roomRef.current?.sendTyping(false, privateTarget || undefined);
      setDraft('');
      setShowEmoji(false);
      setReplyTo(null);
      const pendingSent = { ...sent, deliveryStatus: 'sending' as const };
      setMessages((current) => [...current, pendingSent]);
      if (settings?.saveChat) await saveMessage(pendingSent);
      markOutgoingSentSoon(sent.id);
    }

    if (hasFiles) {
      if (!sendingAttachmentsRef.current) await sendPendingAttachments();
    }
    if (pendingVoice) {
      const voice = pendingVoice;
      setPendingVoice(null);
      await sendVoiceBlob(voice.blob, voice.waveform);
    }
    messageInputRef.current?.focus();
  }

  async function queueAttachment(file: File) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      addLog(`Oversized file rejected before reading: ${file.name} (${Math.round(file.size / 1024 / 1024)}MB)`, 'info');
      showToast(t('attachmentRejected') || t('fileTooLarge'));
      return;
    }
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    if (pendingAttachmentKeysRef.current.has(key)) {
      showToast(t('attachmentAlreadyQueued') || 'Attachment already queued');
      return;
    }
    pendingAttachmentKeysRef.current.add(key);
    let preview: string | undefined;
    if (file.size <= INLINE_PREVIEW_MAX_BYTES && (file.type.startsWith('image/') || file.type.startsWith('video/') || file.type.startsWith('audio/'))) {
      preview = await readFileAsDataUrl(file);
    }
    setPendingAttachments((current) => [...current, { id: nowId(), file, preview }]);
    showToast(t('attachmentQueued') || t('attachmentReady'));
    window.setTimeout(() => messageInputRef.current?.focus(), 20);
  }

  async function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files || []) as File[];
    const allowedFiles = files;
    if (!allowedFiles.length) return;
    event.preventDefault();
    for (const file of allowedFiles) await queueAttachment(file);
  }

  function containsDraggedFiles(dataTransfer: DataTransfer | null): boolean {
    if (!dataTransfer) return false;
    if (Array.from(dataTransfer.types || []).includes('Files')) return true;
    return Array.from(dataTransfer.items || []).some((item) => item.kind === 'file');
  }

  function handleChatDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!containsDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setDraggingAttachments(true);
  }

  function handleChatDragLeave(event: React.DragEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDraggingAttachments(false);
    }
  }

  async function handleChatDrop(event: React.DragEvent<HTMLDivElement>) {
    if (!containsDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setDraggingAttachments(false);
    const files = Array.from(event.dataTransfer?.files || []) as File[];
    if (!files.length) return;
    for (const file of files) await queueAttachment(file);
  }

  function cancelPendingAttachment(id: string) {
    setPendingAttachments((current) => {
      const removed = current.find((entry) => entry.id === id);
      if (removed) pendingAttachmentKeysRef.current.delete(`${removed.file.name}|${removed.file.size}|${removed.file.lastModified}`);
      return current.filter((entry) => entry.id !== id);
    });
    addLog('File transfer cancel requested', 'info');
  }

  async function sendPendingAttachments() {
    if (!roomRef.current || !pendingAttachments.length || sendingAttachmentsRef.current) return;
    const room = roomRef.current;
    const queued = [...pendingAttachments];
    const queuedIds = new Set(queued.map((item) => item.id));
    const targetPeerId = privateTarget || undefined;
    const replyPreview = replyTo ? makeReplyPreview(replyTo) : undefined;
    const startedAt = Date.now();

    sendingAttachmentsRef.current = true;
    setPendingAttachments((current) => current.filter((item) => !queuedIds.has(item.id)));
    setReplyTo(null);
    setMessages((current) => {
      const existingIds = new Set(current.map((message) => message.id));
      const optimistic = queued
        .filter((item) => !existingIds.has(item.id))
        .map((item, index): ChatMessage => {
          const mimeType = item.file.type || 'application/octet-stream';
          return {
            id: item.id,
            roomId,
            sender: 'me',
            senderName: profile?.display_name || t('me'),
            body: item.file.name,
            createdAt: startedAt + index,
            kind: messageKindFromMime(mimeType),
            fileName: item.file.name,
            mimeType,
            fileSize: item.file.size,
            transferredBytes: 0,
            uploadProgress: 0,
            fileStatus: 'sending',
            privateTo: targetPeerId,
            replyToId: replyPreview?.id,
            replyToBody: replyPreview?.body,
            replyToSender: replyPreview?.senderName,
            deliveryStatus: 'sending',
            deliveredTo: [],
            seenBy: []
          };
        });
      return optimistic.length ? [...current, ...optimistic] : current;
    });

    try {
      for (let index = 0; index < queued.length; index += 1) {
        const item = queued[index];
        const key = `${item.file.name}|${item.file.size}|${item.file.lastModified}`;
        try {
          const sent = await room.sendFile(item.file.name, item.file.type || 'application/octet-stream', item.file, targetPeerId, {
            messageId: item.id,
            createdAt: startedAt + index,
            fileSize: item.file.size,
            replyTo: replyPreview,
            onProgress: (progress) => {
              if (roomRef.current !== room) return;
              setMessages((current) => current.map((message) => message.id === item.id ? {
                ...message,
                fileStatus: 'sending',
                uploadProgress: progress,
                transferredBytes: Math.min(item.file.size, Math.round((item.file.size * progress) / 100))
              } : message));
            }
          });
          if (roomRef.current !== room) continue;
          if (!sent) {
            setMessages((current) => current.map((message) => message.id === item.id ? { ...message, fileStatus: 'failed', deliveryStatus: 'sent' } : message));
            showToast(t('fileFailed'));
            continue;
          }
          const localPreviewUrl = (item.file.type.startsWith('image/') || item.file.type.startsWith('video/') || item.file.type.startsWith('audio/')) && !sent.dataUrl && !sent.localPath && sent.fileStatus === 'completed'
            ? URL.createObjectURL(item.file)
            : undefined;
          const completed = { ...sent, dataUrl: sent.dataUrl || localPreviewUrl, deliveryStatus: sent.fileStatus === 'canceled' ? 'sent' as const : 'sending' as const };
          setMessages((current) => {
            const exists = current.some((message) => message.id === item.id);
            return exists
              ? current.map((message) => message.id === item.id ? { ...message, ...completed, createdAt: message.createdAt } : message)
              : [...current, completed];
          });
          if (sent.fileStatus !== 'canceled') {
            if (settings?.saveChat) await saveMessage(sent);
            markOutgoingSentSoon(sent.id);
          }
        } catch (error) {
          addLog(`File upload failed: ${item.file.name}: ${String((error as Error)?.message || error)}`, 'error');
          if (roomRef.current === room) {
            setMessages((current) => current.map((message) => message.id === item.id ? { ...message, fileStatus: 'failed', deliveryStatus: 'sent' } : message));
            showToast(t('fileFailed'));
          }
        } finally {
          pendingAttachmentKeysRef.current.delete(key);
        }
      }
    } finally {
      sendingAttachmentsRef.current = false;
    }
  }

  async function sendVoiceBlob(blob: Blob, prebuiltWaveform?: number[]) {
    if (!roomRef.current) return;
    const voiceMimeType = blob.type.startsWith('audio/') ? blob.type : 'audio/webm';
    const voiceBlob = blob.type === voiceMimeType ? blob : new Blob([blob], { type: voiceMimeType });
    const dataUrl = await readFileAsDataUrl(voiceBlob);
    const waveform = prebuiltWaveform || await makeWaveform(voiceBlob);
    const sent = await roomRef.current.sendFile(`voice-${Date.now()}.webm`, voiceMimeType, dataUrl, privateTarget || undefined, { replyTo: replyTo ? makeReplyPreview(replyTo) : undefined, waveform });
    if (!sent) {
      showToast(t('voiceFailed'));
      return;
    }
    const pendingSent = { ...sent, deliveryStatus: 'sending' as const };
    setMessages((current) => [...current, pendingSent]);
    setReplyTo(null);
    if (settings?.saveChat) await saveMessage(pendingSent);
    markOutgoingSentSoon(sent.id);
  }

  async function finalizeCompanionVoiceRecording(recordingId: string) {
    if (!roomRef.current || !recordingId || voiceRecordStopInFlightRef.current) return;
    voiceRecordStopInFlightRef.current = true;
    try {
      const blob = await roomRef.current.stopVoiceMessageRecording(recordingId);
      companionVoiceRecordingIdRef.current = '';
      setRecording(false);
      if (blob.size < 256) {
        showToast(t('voiceFailed'));
        return;
      }
      const waveform = await makeWaveform(blob);
      const dataUrl = await readFileAsDataUrl(blob);
      setPendingVoice({ blob, dataUrl, waveform });
      window.setTimeout(() => messageInputRef.current?.focus(), 20);
    } catch (error) {
      companionVoiceRecordingIdRef.current = '';
      setRecording(false);
      const message = String((error as Error)?.message || error || t('recordingProblem'));
      addLog(`Voice message finalization failed: ${message}`, 'error');
      showError(message);
    } finally {
      voiceRecordStopInFlightRef.current = false;
    }
  }

  async function startVoiceRecording() {
    if (recording || companionVoiceRecordingIdRef.current || voiceRecordStartInFlightRef.current) return;
    if (forcedMutedByAdmin && !isRoomOwner) { showToast(t('mutedByAdmin')); return; }
    voiceRecordStopRequestedRef.current = false;
    voiceRecordStartInFlightRef.current = true;

    try {
      if (roomRef.current) {
        const started = await roomRef.current.startVoiceMessageRecording(activeSettings?.audioInputId || undefined);
        companionVoiceRecordingIdRef.current = started.recordingId;
        setRecording(true);
        addLog('Voice message is recording through the isolated MHTalkVoice microphone source', 'info');
        if (voiceRecordStopRequestedRef.current) await finalizeCompanionVoiceRecording(started.recordingId);
        return;
      }

      // This fallback is only used outside an active room. During calls, MHTalkVoice owns
      // the microphone so a second WebView capture cannot reset or mute the call track.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: buildRecorderMicConstraints(activeSettings?.audioInputId || undefined),
        video: false
      });
      recorderReleaseRef.current = () => stream.getTracks().forEach((track) => track.stop());
      recordedChunksRef.current = [];
      const mimeType = pickVoiceRecorderMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) recordedChunksRef.current.push(event.data); };
      recorder.onerror = () => {
        showError(t('recordingProblem'));
        try { recorderReleaseRef.current?.(); } catch { /* ignore */ }
        recorderReleaseRef.current = null;
        setRecording(false);
      };
      recorder.onstop = async () => {
        try { recorderReleaseRef.current?.(); } catch { /* ignore */ }
        recorderReleaseRef.current = null;
        setRecording(false);
        const blobType = recorder.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(recordedChunksRef.current, { type: blobType });
        recordedChunksRef.current = [];
        if (blob.size < 256) { showToast(t('voiceFailed')); return; }
        const waveform = await makeWaveform(blob);
        const dataUrl = await readFileAsDataUrl(blob);
        setPendingVoice({ blob, dataUrl, waveform });
        window.setTimeout(() => messageInputRef.current?.focus(), 20);
      };
      recorder.start(250);
      setRecording(true);
      if (voiceRecordStopRequestedRef.current && recorder.state !== 'inactive') recorder.stop();
    } catch (error) {
      try { recorderReleaseRef.current?.(); } catch { /* ignore */ }
      recorderReleaseRef.current = null;
      companionVoiceRecordingIdRef.current = '';
      setRecording(false);
      const message = String((error as Error)?.message || error || t('recordingDenied'));
      addLog(`Voice message could not start: ${message}`, 'error');
      showError(message);
    } finally {
      voiceRecordStartInFlightRef.current = false;
    }
  }

  function stopVoiceRecordingPreview() {
    voiceRecordStopRequestedRef.current = true;
    const companionRecordingId = companionVoiceRecordingIdRef.current;
    if (companionRecordingId) {
      finalizeCompanionVoiceRecording(companionRecordingId).catch(() => undefined);
      return;
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  async function copyRoomId() {
    if (!roomId) return;
    await navigator.clipboard.writeText(roomId).catch(() => undefined);
    setRoomCopied(true);
    window.setTimeout(() => setRoomCopied(false), 1400);
    showToast(t('copied'));
  }

  async function toggleVoice() {
    if (!roomRef.current || !activeSettings) return;
    try {
      if (voiceActive) {
        await roomRef.current.stopVoice();
        setVoiceActive(false);
        setMicEnabled(false);
      } else {
        await startRoomVoice(roomRef.current);
        rememberMicAutoStartSuccess();
          setVoiceActive(true);
        setMicEnabled(true);
      }
    } catch {
      showToast(t('micPermission'));
    }
  }

  async function toggleMicMute() {
    if (!roomRef.current || !activeSettings) return;
    if (forcedMutedByAdmin && !isRoomOwner) { showToast(t('mutedByAdmin')); return; }
    if (!voiceActive) {
      try {
        await startRoomVoice(roomRef.current);
        rememberMicAutoStartSuccess();
          setVoiceActive(true);
        setMicEnabled(true);
      } catch { showToast(t('micPermission')); }
      return;
    }
    const next = !micEnabled;
    roomRef.current.setMicEnabled(next);
    setMicEnabled(next);
    if (!next) updateSpeaking(localPeerId, false);
  }

  async function startScreenShareOnly(): Promise<MediaStream | null> {
    if (!roomRef.current || !activeSettings) return null;
    if (screenSharing) return localScreenStream || roomRef.current.getLocalScreenStream() || null;
    if (activeSettings.screenQuality === 'audio-only') {
      showToast(t('audioOnlyHint'));
      return null;
    }
    await roomRef.current.startScreen(activeSettings.screenQuality, activeSettings.screenFps);
    if (cameraWithStreamArmedRef.current) await ensureCameraWithStreamOverlay();
    const stream = roomRef.current.getLocalScreenStream() || null;
    setLocalScreenStream(stream);
    setScreenSharing(true);
    playTone('screen-on');
    return stream;
  }

  async function stopScreenShareOnly() {
    if (!roomRef.current) return;
    // stop() closes MediaRecorder immediately; MP4 conversion continues while the broadcast is being closed.
    const finalizeRecording = stopScreenRecording(true);
    await roomRef.current.stopScreen();
    setScreenSharing(false);
    setLocalScreenStream(null);
    playTone('screen-off');
    await finalizeRecording;
  }

  async function toggleScreen() {
    if (!roomRef.current || !activeSettings) return;
    try {
      if (screenSharing) await stopScreenShareOnly();
      else await startScreenShareOnly();
    } catch {
      showToast(t('screenPermission'));
    }
  }

  async function refreshDevices() { setDevices(await listMediaDevices()); }

  async function clearCurrentChat() {
    if (!roomId) return;
    await clearRoomMessages(roomId);
    setMessages([systemMessage(roomId, t('chatCleared'))]);
  }

  async function wipeData() {
    if (!window.confirm(t('confirmWipe'))) return;
    await roomRef.current?.cleanDisconnect();
    await clearAllLocalData();
    const [loadedProfile, loadedSettings] = await Promise.all([loadProfile(), loadSettings()]);
    setProfile(loadedProfile);
    setSettingsState(loadedSettings);
    await leaveRoom(false);
    showToast(t('dataWiped'));
  }

  async function toggleFullscreen() {
    const target = mediaBoxRef.current;
    if (!target) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await target.requestFullscreen();
  }

  async function openPictureInPicture() {
    const video = activeVideoRef.current as HTMLVideoElement & { requestPictureInPicture?: () => Promise<PictureInPictureWindow> };
    if (!video || !video.requestPictureInPicture) {
      showToast(t('pipUnsupported'));
      return;
    }
    try {
      await video.requestPictureInPicture();
      setPipPeerId(activePeer?.peerId || '');
      video.onleavepictureinpicture = () => setPipPeerId('');
    }
    catch { showToast(t('pipStartFirst')); }
  }

  async function openInstagram() {
    try { await openUrl(INSTAGRAM_URL); }
    catch { window.open(INSTAGRAM_URL, '_blank', 'noopener,noreferrer'); }
  }

  async function minimizeWindow() { await getCurrentWindow().minimize(); }
  async function toggleMaximizeWindow() { await getCurrentWindow().toggleMaximize(); }
  async function hideToTray() { await getCurrentWindow().hide(); }
  async function closeWindow(ask = true) {
    if (shutdownInProgressRef.current) {
      addLog('Graceful shutdown skipped duplicate request');
      allowWindowCloseRef.current = true;
      try { await getCurrentWindow().close(); } catch { /* ignore */ }
      window.setTimeout(() => { exit(0).catch(() => undefined); }, 80);
      return;
    }
    if (ask && roomId && !window.confirm(t('confirmCloseApp'))) return;
    shutdownInProgressRef.current = true;
    addLog('Graceful shutdown started');
    try {
      stopMicTest();
      try { await stopScreenRecording(false); } catch { /* ignore */ }
      try { await roomRef.current?.stopScreen(false); } catch { /* ignore */ }
      try { await roomRef.current?.stopVoice(); } catch { /* ignore */ }
      try { await invoke('stop_native_system_audio_excluding_self'); } catch { /* ignore */ }
      try { await roomRef.current?.cleanDisconnect(); } catch { /* ignore */ }
    } finally {
      addLog('Graceful shutdown completed');
      allowWindowCloseRef.current = true;
      try { await getCurrentWindow().close(); } catch { /* fall through to process exit */ }
      window.setTimeout(() => { exit(0).catch(() => undefined); }, 120);
    }
  }

  function setVolume(peerId: string, key: keyof PeerVolume, value: number | boolean) {
    setPeerVolumes((current) => ({
      ...current,
      [peerId]: { ...(current[peerId] || defaultVolume()), [key]: value }
    }));
  }

  function privateTargetName() {
    return privateTarget ? peers[privateTarget]?.displayName || t('friendFallback') : '';
  }


  function memberIsMuted(peerId: string) {
    return peerId === localPeerId ? Boolean(forcedMutedByAdmin || (voiceActive ? !micEnabled : false)) : Boolean(adminMutedPeers[peerId] || peerMedia[peerId]?.micEnabled === false);
  }

  function renderAvatar(peer: PeerProfile | { peerId: string; displayName: string; avatar?: string | null }) {
    const muted = memberIsMuted(peer.peerId);
    const speaking = speakingPeers[peer.peerId];
    return <span className={`profile-avatar-mini ${muted ? 'muted-avatar' : ''} ${speaking ? 'speaking-avatar' : ''}`} style={{ '--speak-color': speakingColor(peer.peerId) } as CSSProperties}>
      {peer.avatar ? <img src={peer.avatar} alt="avatar" /> : peer.displayName.slice(0, 1).toUpperCase()}
      {muted && <i className="mute-badge">🎙</i>}
    </span>;
  }


  async function deleteChatMessage(message: ChatMessage) {
    if (message.sender !== 'me' || message.deletedAt) return;
    if (!window.confirm(t('confirmDeleteMessage'))) return;
    const result = roomRef.current?.deleteMessage(message.id, message.privateTo || undefined);
    if (!result) {
      showToast(t('chatDisconnected'));
      return;
    }
    setMessages((current) => current.map((item) => item.id === message.id ? { ...item, body: '', dataUrl: undefined, deletedAt: result.deletedAt } : item));
    if (settings?.saveChat) await markMessageDeleted(message.id, result.deletedAt);
  }

  function openBannedMembers() {
    roomRef.current?.requestBans();
    setBanModalOpen(true);
  }

  function unbanMember(peerId: string) {
    roomRef.current?.unbanPeer(peerId);
    setBannedMembers((current) => current.filter((member) => member.peerId !== peerId));
  }

  function kickPeer(peerId: string) {
    if (!canModerate) {
      showToast(t('ownerOnly'));
      return;
    }
    if (!window.confirm(t('kickConfirm'))) return;
    roomRef.current?.kickPeer(peerId);
    showToast(t('kickedMember'));
  }

  function approveJoin(peerId: string) {
    roomRef.current?.approveJoin(peerId);
    setJoinRequests((current) => { const next = { ...current }; delete next[peerId]; return next; });
  }

  function rejectJoin(peerId: string) {
    roomRef.current?.rejectJoin(peerId);
    setJoinRequests((current) => { const next = { ...current }; delete next[peerId]; return next; });
  }

  function promotePeer(peerId: string) {
    if (!isRoomOwner) { showToast(t('ownerOnly')); return; }
    roomRef.current?.promotePeer(peerId);
    showToast(t('promotedMember'));
  }

  function togglePublicMutePeer(peerId: string) {
    if (!canModerate) { showToast(t('ownerOnly')); return; }
    if (!peerId || peerId === localPeerId) return;
    const currentlyMuted = Boolean(adminMutedPeers[peerId]);
    if (currentlyMuted) {
      roomRef.current?.unmutePeerForRoom(peerId);
      setAdminMutedPeers((current) => { const next = { ...current }; delete next[peerId]; return next; });
      setPeerMedia((current) => ({ ...current, [peerId]: { ...(current[peerId] || { screenSharing: false, micEnabled: true, cameraSharing: false }), micEnabled: true } }));
      addLog(`Admin/moderator public unmute: ${peerId}`, 'info');
      return;
    }
    roomRef.current?.mutePeerForRoom(peerId);
    setAdminMutedPeers((current) => ({ ...current, [peerId]: true }));
    setPeerMedia((current) => ({ ...current, [peerId]: { ...(current[peerId] || { screenSharing: false, micEnabled: true, cameraSharing: false }), micEnabled: false } }));
    addLog(`Admin/moderator public mute: ${peerId}`, 'info');
  }

  function muteAllMembers() {
    if (!isRoomOwner) { showToast(t('ownerOnly')); return; }
    if (globalMuteActive) {
      const snapshot = globalMuteSnapshotRef.current || {};
      roomRef.current?.unmuteAllMembers();
      for (const peer of peerList) {
        if (snapshot[peer.peerId]) roomRef.current?.mutePeerForRoom(peer.peerId);
      }
      setAdminMutedPeers(snapshot);
      setPeerMedia((current) => {
        const next = { ...current };
        for (const peer of peerList) {
          const restoredMuted = Boolean(snapshot[peer.peerId]);
          next[peer.peerId] = { ...(next[peer.peerId] || { screenSharing: false, micEnabled: true, cameraSharing: false }), micEnabled: !restoredMuted };
        }
        return next;
      });
      setGlobalMuteActive(false);
      globalMuteActiveRef.current = false;
      globalMuteSnapshotRef.current = null;
      setForcedMutedByAdmin(false);
      showToast(t('unmuteAllMembers'));
      addLog('Admin unmuted all members and restored original public mute states', 'info');
      return;
    }
    globalMuteSnapshotRef.current = { ...adminMutedPeers };
    setGlobalMuteActive(true);
    globalMuteActiveRef.current = true;
    roomRef.current?.muteAllMembers();
    const muted: Record<string, boolean> = {};
    for (const peer of peerList) if (peer.peerId !== localPeerId) muted[peer.peerId] = true;
    setForcedMutedByAdmin(false);
    setAdminMutedPeers(muted);
    setPeerMedia((current) => {
      const next = { ...current };
      for (const peer of peerList) next[peer.peerId] = { ...(next[peer.peerId] || { screenSharing: false, micEnabled: true, cameraSharing: false }), micEnabled: false };
      return next;
    });
    showToast(t('adminMutedAll'));
    addLog('Admin muted all members and saved original mute states', 'info');
  }

  function requestToSpeak() {
    const now = Date.now();
    if (now - raiseHandLastAt < 15_000) { showToast(t('speakRequestCooldown')); addLog('Request to speak cooldown active', 'info'); return; }
    setRaiseHandLastAt(now);
    roomRef.current?.requestToSpeak();
    showToast(t('requestedPermissionToSpeak'));
  }

  function allowToSpeak(peerId: string) {
    roomRef.current?.allowMemberToSpeak(peerId);
    setAdminMutedPeers((current) => { const next = { ...current }; delete next[peerId]; return next; });
    setPeerMedia((current) => ({ ...current, [peerId]: { ...(current[peerId] || { screenSharing: false, micEnabled: true, cameraSharing: false }), micEnabled: true } }));
    setSpeakRequests((current) => { const next = { ...current }; delete next[peerId]; return next; });
    addLog(`Admin allowed member to speak: ${peerId}`, 'info');
  }

  function rejectSpeak(peerId: string) {
    roomRef.current?.rejectSpeakRequest(peerId);
    setSpeakRequests((current) => { const next = { ...current }; delete next[peerId]; return next; });
    addLog(`Admin rejected speak request: ${peerId}`, 'info');
  }

  async function setDesktopOverlayInteractive(interactive: boolean) {
    overlayInteractiveRef.current = interactive;
    const current = settings?.chatOverlay || DEFAULT_SETTINGS.chatOverlay;
    const next = clampOverlaySettings({ ...current, interactive });
    setOverlayDraft((draft) => draft ? { ...draft, interactive } : draft);
    if (settings) await updateSettings({ ...settings, chatOverlay: next });
    if (chatOverlayOpen && chatOverlayExternal && chatOverlayWindowRef.current) {
      const geometry = await desktopChatOverlayGeometry(next);
      await hardenDesktopChatOverlayWindow(chatOverlayWindowRef.current, geometry, interactive);
      await emit('mhlko://chat-overlay-settings', next).catch(() => undefined);
      if (interactive) {
        try { await (chatOverlayWindowRef.current as any).setFocus?.(); } catch { /* native focus may be blocked by a protected fullscreen app */ }
      }
    }
    showToast(`${t('overlayModeChanged')}: ${interactive ? t('overlayInteractive') : t('overlayClickThrough')}`);
  }

  async function toggleChatOverlay() {
    if (chatOverlayOpen) {
      try { await hardenDesktopChatOverlayWindow(chatOverlayWindowRef.current as WebviewWindow, await desktopChatOverlayGeometry(settings?.chatOverlay), Boolean(settings?.chatOverlay?.interactive)); } catch { /* ignore before close */ }
      try { await chatOverlayWindowRef.current?.close(); } catch { /* overlay may already be closed */ }
      chatOverlayWindowRef.current = null;
      setChatOverlayExternal(false);
      setChatOverlayOpen(false);
      addLog(t('chatOverlayHidden'), 'info');
      return;
    }

    // 0.7.7: restore the 0.7.4 desktop-only chat overlay path exactly.
    // The overlay must be a true external Tauri WebviewWindow and must not fall
    // back into the main app UI, so screen overlays stay outside the app.
    setChatOverlayOpen(true);
    setChatOverlayExternal(true);
    try {
      const geometry = await desktopChatOverlayGeometry(settings?.chatOverlay);
      const overlay = new WebviewWindow('mhlko-chat-overlay', {
        url: '/?overlay=chat',
        title: 'MHTalk Chat Overlay',
        width: geometry.width,
        height: geometry.height,
        x: geometry.x,
        y: geometry.y,
        decorations: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: Boolean(settings?.chatOverlay?.interactive),
        focus: Boolean(settings?.chatOverlay?.interactive),
        visible: true,
        shadow: false
      } as any);
      chatOverlayWindowRef.current = overlay;
      const publish = async () => {
        await hardenDesktopChatOverlayWindow(overlay, geometry, Boolean(settings?.chatOverlay?.interactive));
        await emit('mhlko://chat-overlay-settings', settings?.chatOverlay || DEFAULT_SETTINGS.chatOverlay).catch(() => undefined);
        await emit('mhlko://chat-overlay-update', overlayMessages).catch(() => undefined);
      };
      try {
        overlay.once('tauri://created', () => {
          publish().catch(() => undefined);
          addLog(`${t('chatOverlayShown')} desktop-always-on-top`, 'info');
        }).catch(() => undefined);
        overlay.once('tauri://error', () => {
          chatOverlayWindowRef.current = null;
          setChatOverlayExternal(false);
          setChatOverlayOpen(false);
          addLog('Chat overlay desktop window failed; in-app overlay is disabled to keep overlay outside the app only.', 'error');
          showToast(t('chatOverlayHidden'));
        }).catch(() => undefined);
      } catch {
        publish().catch(() => undefined);
      }
      window.setTimeout(() => publish().catch(() => undefined), 450);
    } catch {
      chatOverlayWindowRef.current = null;
      setChatOverlayExternal(false);
      setChatOverlayOpen(false);
      addLog('Chat overlay desktop window unavailable; in-app overlay is disabled to keep overlay outside the app only.', 'error');
      showToast(t('chatOverlayHidden'));
    }
  }


  function updateOverlayDraft(partial: Partial<ChatOverlaySettings>) {
    setOverlayDraft((current) => clampOverlaySettings({ ...(current || settings?.chatOverlay || DEFAULT_SETTINGS.chatOverlay), ...partial }));
  }

  async function saveOverlayDraft() {
    const next = clampOverlaySettings(overlayDraft || settings?.chatOverlay || DEFAULT_SETTINGS.chatOverlay);
    updateDraftSettings({ chatOverlay: next });
    if (settings) await updateSettings({ ...settings, chatOverlay: next });
    setOverlayEditorOpen(false);
    if (chatOverlayOpen && chatOverlayExternal && chatOverlayWindowRef.current) {
      const geometry = await desktopChatOverlayGeometry(next);
      await hardenDesktopChatOverlayWindow(chatOverlayWindowRef.current, geometry, next.interactive);
      await emit('mhlko://chat-overlay-settings', next).catch(() => undefined);
    }
    showToast(t('overlayPersisted'));
  }

  function updateCameraDraft(partial: Partial<CameraOverlaySettings>) {
    setCameraDraft((current) => {
      const next = clampCameraSettings({ ...(current || settings?.cameraOverlay || DEFAULT_CAMERA_OVERLAY), ...partial });
      if (cameraOpen && cameraMode === 'camera-with-stream') roomRef.current?.updateCameraOverlay(next);
      return next;
    });
  }

  async function saveCameraDraft() {
    const next = clampCameraSettings(cameraDraft || settings?.cameraOverlay || DEFAULT_CAMERA_OVERLAY);
    updateDraftSettings({ cameraOverlay: next });
    if (settings) await updateSettings({ ...settings, cameraOverlay: next });
    setCameraBox({ x: next.xPercent, y: next.yPercent, width: next.widthPercent, height: next.heightPercent });
    if (cameraOpen && cameraMode === 'camera-with-stream') roomRef.current?.updateCameraOverlay(next);
    setCameraSettingsOpen(false);
    showToast(t('overlayPersisted'));
  }

  function cameraMockPointer(event: ReactPointerEvent<HTMLElement>, mode: 'move' | 'resize') {
    event.preventDefault();
    const target = event.currentTarget.parentElement as HTMLDivElement | null;
    if (!target) return;
    const draft = clampCameraSettings(cameraDraft || settings?.cameraOverlay || DEFAULT_CAMERA_OVERLAY);
    const rect = target.getBoundingClientRect();
    const start = { x: draft.xPercent, y: draft.yPercent, width: draft.widthPercent, height: draft.heightPercent };
    const startX = event.clientX;
    const startY = event.clientY;
    const move = (moveEvent: PointerEvent) => {
      const dx = ((moveEvent.clientX - startX) / Math.max(1, rect.width)) * 100;
      const dy = ((moveEvent.clientY - startY) / Math.max(1, rect.height)) * 100;
      if (mode === 'move') {
        const snap = (value: number, size: number) => {
          const clamped = Math.min(100 - size, Math.max(0, value));
          const edges = [0, 50 - size / 2, 100 - size];
          const nearest = edges.reduce((best, item) => Math.abs(item - clamped) < Math.abs(best - clamped) ? item : best, clamped);
          return Math.abs(nearest - clamped) <= 2.2 ? nearest : clamped;
        };
        updateCameraDraft({ xPercent: snap(start.x + dx, start.width), yPercent: snap(start.y + dy, start.height) });
      } else {
        const ratio = Math.max(0.25, start.width / Math.max(1, start.height));
        const requestedWidth = start.width + (Math.abs(dx) >= Math.abs(dy) ? dx : dy * ratio);
        const widthPercent = Math.min(70, Math.max(10, requestedWidth));
        updateCameraDraft({ widthPercent, heightPercent: widthPercent / ratio });
      }
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function overlayMockPointer(event: ReactPointerEvent<HTMLElement>, mode: 'move' | 'resize') {
    event.preventDefault();
    const target = event.currentTarget.parentElement as HTMLDivElement | null;
    if (!target) return;
    const draft = clampOverlaySettings(overlayDraft || settings?.chatOverlay || DEFAULT_SETTINGS.chatOverlay);
    const rect = target.getBoundingClientRect();
    const start = { x: draft.xPercent, y: draft.yPercent, width: draft.widthPercent, height: draft.heightPercent };
    const startX = event.clientX;
    const startY = event.clientY;
    const move = (moveEvent: PointerEvent) => {
      const dx = ((moveEvent.clientX - startX) / Math.max(1, rect.width)) * 100;
      const dy = ((moveEvent.clientY - startY) / Math.max(1, rect.height)) * 100;
      if (mode === 'move') updateOverlayDraft({ xPercent: start.x + dx, yPercent: start.y + dy });
      else updateOverlayDraft({ widthPercent: start.width + dx, heightPercent: start.height + dy });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }


  async function ensureCameraWithStreamOverlay(): Promise<MediaStream | null> {
    const room = roomRef.current;
    if (!room) return null;
    if (room.isCameraOverlayActive()) {
      const activeCamera = room.getLocalCameraStream() || null;
      if (activeCamera) {
        setCameraStream(activeCamera);
        setCameraOpen(true);
      }
      return activeCamera;
    }
    if (cameraOverlayStartPromiseRef.current) return cameraOverlayStartPromiseRef.current;
    const promise = (async () => {
      cameraSetupPreviewStream?.getTracks().forEach((track) => { try { track.stop(); } catch { /* ignore */ } });
      setCameraSetupPreviewStream(null);
      const deviceId = settingsForm.cameraInputId || settings?.cameraInputId || undefined;
      const stream = await room.startCameraOverlay(
        deviceId,
        clampCameraSettings(cameraDraft || settings?.cameraOverlay || DEFAULT_CAMERA_OVERLAY)
      );
      setCameraMode('camera-with-stream');
      cameraWithStreamArmedRef.current = true;
      setCameraWithStreamArmed(true);
      setCameraStream(stream);
      setCameraOpen(true);
      setCameraSettingsOpen(false);
      setLocalScreenStream(room.getLocalScreenStream() || null);
      return stream;
    })();
    cameraOverlayStartPromiseRef.current = promise;
    try { return await promise; }
    finally { if (cameraOverlayStartPromiseRef.current === promise) cameraOverlayStartPromiseRef.current = null; }
  }

  async function toggleCameraOverlay(nextMode: 'camera-only' | 'camera-with-stream' = cameraMode) {
    if (cameraOpen) {
      try { await roomRef.current?.stopCameraShare(true); } catch { /* ignore */ }
      try { cameraStream?.getTracks().forEach((track) => track.stop()); } catch { /* ignore */ }
      setCameraStream(null);
      setCameraOpen(false);
      if (nextMode === 'camera-with-stream') { cameraWithStreamArmedRef.current = false; setCameraWithStreamArmed(false); }
      return;
    }
    if (nextMode === 'camera-with-stream' && !screenSharing) {
      setCameraMode('camera-with-stream');
      cameraWithStreamArmedRef.current = true;
      setCameraWithStreamArmed(true);
      setCameraSettingsOpen(false);
      showToast(t('cameraWillStartWithStream'));
      addLog('Camera with stream armed; waiting for screen share', 'info');
      return;
    }
    try {
      if (nextMode === 'camera-with-stream') {
        await ensureCameraWithStreamOverlay();
        return;
      }
      cameraSetupPreviewStream?.getTracks().forEach((track) => { try { track.stop(); } catch { /* ignore */ } });
      setCameraSetupPreviewStream(null);
      const deviceId = settingsForm.cameraInputId || settings?.cameraInputId || undefined;
      setCameraMode(nextMode);
      const stream = roomRef.current
        ? await roomRef.current.startCameraShare(deviceId)
        : await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { ideal: deviceId } } : true, audio: false });
      setCameraStream(stream);
      setCameraOpen(true);
      setCameraSettingsOpen(false);
    } catch {
      showToast(t('cameraUnavailable'));
    }
  }

  function startCameraDrag(event: ReactPointerEvent<HTMLElement>, mode: 'move' | 'resize') {
    event.preventDefault();
    const start = cameraBox;
    const startX = event.clientX;
    const startY = event.clientY;
    const parent = mediaBoxRef.current?.getBoundingClientRect();
    const width = parent?.width || 800;
    const height = parent?.height || 450;
    const move = (moveEvent: PointerEvent) => {
      const dx = ((moveEvent.clientX - startX) / width) * 100;
      const dy = ((moveEvent.clientY - startY) / height) * 100;
      let next: CameraBox;
      if (mode === 'move') {
        next = { ...start, x: Math.min(100 - start.width, Math.max(0, start.x + dx)), y: Math.min(100 - start.height, Math.max(0, start.y + dy)) };
      } else {
        const ratio = Math.max(0.25, start.width / Math.max(1, start.height));
        const nextWidth = Math.min(70, Math.max(12, start.width + (Math.abs(dx) >= Math.abs(dy) ? dx : dy * ratio)));
        next = { ...start, width: nextWidth, height: nextWidth / ratio };
      }
      setCameraBox(next);
      if (cameraMode === 'camera-with-stream') {
        roomRef.current?.updateCameraOverlay(clampCameraSettings({
          ...(settings?.cameraOverlay || DEFAULT_CAMERA_OVERLAY),
          xPercent: next.x,
          yPercent: next.y,
          widthPercent: next.width,
          heightPercent: next.height
        }));
      }
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }


  function troubleshootConnection() {
    if (!roomRef.current) return;
    roomRef.current.restartConnection();
    setConnection('reconnecting');
    setConnectionLabel('state_reconnecting');
    showToast(t('restartConnectionStarted'));
  }

  function showPeerStream(peerId: string) {
    if (!peerId) return;
    if (!peerMedia[peerId]?.screenSharing) {
      setPeerMenuId(peerMenuId === peerId ? '' : peerId);
      return;
    }
    const switching = Boolean(activePeerId && activePeerId !== peerId);
    setActiveMediaMode('screen');
    setActivePeerId(peerId);
    setPeerMenuId('');
    closedStreamPeersRef.current.delete(peerId);
    setStreamVolumeOpen(false);
    addLog(switching ? `Stream switched: ${peers[peerId]?.displayName || peerId}` : `${t('streamViewerOpened')}: ${peers[peerId]?.displayName || peerId}`, 'info');
  }

  function showPeerCamera(peerId: string) {
    if (!peerId) return;
    if (!peerMedia[peerId]?.cameraSharing) {
      setPeerMenuId(peerMenuId === peerId ? '' : peerId);
      return;
    }
    const switching = Boolean(activePeerId && (activePeerId !== peerId || activeMediaMode !== 'camera'));
    setActiveMediaMode('camera');
    setActivePeerId(peerId);
    setPeerMenuId('');
    closedStreamPeersRef.current.delete(peerId);
    setStreamVolumeOpen(false);
    addLog(switching ? `Camera view switched: ${peers[peerId]?.displayName || peerId}` : `${t('viewCamera')}: ${peers[peerId]?.displayName || peerId}`, 'info');
  }

  function closeCurrentStream() {
    if (activePeerId) {
      closedStreamPeersRef.current.add(activePeerId);
      addLog(`${t('streamViewerClosed')}: ${peers[activePeerId]?.displayName || activePeerId}`, 'info');
    }
    if (document.pictureInPictureElement && document.exitPictureInPicture) {
      document.exitPictureInPicture().catch(() => undefined);
    }
    setActivePeerId('');
    setPipPeerId('');
    setStreamVolumeOpen(false);
  }

  function streamActionLabel(peerId: string) {
    const isStreaming = Boolean(peerMedia[peerId]?.screenSharing || peerMedia[peerId]?.cameraSharing);
    if (!isStreaming) return '';
    if (activePeerId === peerId && streamViewerOpen) return activeMediaMode === 'camera' ? t('viewCamera') : t('watchingStream');
    if (activePeerId && activePeerId !== peerId && streamViewerOpen) return t('switchStream');
    return peerMedia[peerId]?.screenSharing ? t('openStream') : t('viewCamera');
  }

  function restartWatchedStream() {
    if (!roomRef.current || !activePeer?.peerId) return;
    const peerId = activePeer.peerId;
    setStreamRefreshTokens((current) => ({ ...current, [peerId]: (current[peerId] || 0) + 1 }));
    setScreenStreams((current) => ({ ...current }));
    roomRef.current.restartRemoteStream(peerId);
    showToast(t('watchedStreamRestarted'));
  }

  function startWindowDrag(event: ReactMouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('button,input,select,textarea,a,label')) return;
    getCurrentWindow().startDragging().catch(() => undefined);
  }

  function typingLabel() {
    if (!typingNames.length) return '';
    if (typingNames.length === 1) return lang === 'ar' ? `${typingNames[0]} ${t('typingOne')}` : `${typingNames[0]} ${t('typingOne')}`;
    const names = typingNames.slice(0, 2).join(t('typingSeparator'));
    return lang === 'ar' ? `${names} ${t('typingMany')}` : `${names} ${t('typingMany')}`;
  }

  if (!ready || !profile || !settings || !activeSettings) {
    return <main className="boot" dir={isRtl ? 'rtl' : 'ltr'}><div className="loader" /> <span>{t('boot')}</span></main>;
  }

  if (!updateGateChecked || requiredUpdate) {
    return <main className="boot forced-update-page" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="profile-modal forced-update-modal startup-update-modal">
        <div className="forced-update-icon">↻</div>
        <h2>{requiredUpdate ? t('updateRequiredTitle') : t('checkingUpdates')}</h2>
        <p>{requiredUpdate ? t('updateAutoInstalling') : t('updateBootChecking')}</p>
        {requiredUpdate && <p className="mini">{t('updateAvailable')}: {requiredUpdate.version}</p>}
        {requiredUpdate?.notes && <pre className="update-notes">{requiredUpdate.notes}</pre>}
        {updateProgress && <p className="mini update-progress">{updateProgress}</p>}
        {updateBusy ? <div className="loader" /> : requiredUpdate ? <div className="update-gate-actions"><button className="primary-update-btn" onClick={() => installRequiredUpdate()}>{t('updateInstall')}</button><button onClick={() => checkForUpdates(true)}>{t('updateRetry')}</button></div> : <div className="update-gate-actions"><button onClick={() => checkForUpdates(true)}>{t('updateRetry')}</button><button onClick={continueOfflineFromUpdateGate}>{t('continueOffline')}</button></div>}
      </div>
    </main>;
  }

  return (
    <main className={`app lang-${lang} ${isRtl ? 'rtl-app' : 'ltr-app'}`} dir={isRtl ? 'rtl' : 'ltr'}>
      <header className="titlebar" data-tauri-drag-region onMouseDown={startWindowDrag}>
        <div className={`pill state-${connection}`}>{displayConnectionLabel}</div>
        {roomId && connectionLabel !== 'state_waiting_approval' && ['connecting', 'reconnecting', 'disconnected', 'failed'].includes(connection) && <button className="troubleshoot-btn" onClick={troubleshootConnection}>{t('troubleshootConnection')}</button>}
        <div className="title-actions" data-tauri-drag-region>
          {roomId && canModerate && <button ref={joinBellRef} className="join-bell" onClick={() => setJoinRequestsOpen((open) => !open)} title={t('joinRequests')}>🔔{Object.keys(joinRequests).length > 0 && <b>{Object.keys(joinRequests).length}</b>}</button>}
          {roomId && !waitingForApproval && <button className="top-call-btn" onClick={toggleScreen} title={screenSharing ? t('stopShare') : t('shareScreen')}>{screenSharing ? '■' : '🖥️'}</button>}
          {roomId && !waitingForApproval && <button
            className={`top-call-btn screen-record-toggle ${screenRecorderState === 'recording' || screenRecorderState === 'paused' ? 'active recording' : ''} ${screenRecorderArmed ? 'armed' : ''} ${screenRecorderState === 'stopping' ? 'finalizing' : ''}`}
            onClick={() => toggleScreenRecorderToolbar().catch(() => undefined)}
            disabled={screenRecorderState === 'stopping'}
            title={screenRecorderState === 'recording' || screenRecorderState === 'paused' ? t('screenRecorderToolbarStop') : screenRecorderArmed ? t('screenRecorderArmed') : t('screenRecorderToolbarStart')}
          >
            {screenRecorderState === 'stopping' ? '…' : screenRecorderState === 'recording' || screenRecorderState === 'paused' ? '■' : '●'}
            {(screenRecorderState === 'recording' || screenRecorderState === 'paused') && <small>{formatRecorderDuration(screenRecorderElapsed)}</small>}
          </button>}
          {roomId && !waitingForApproval && <button className="top-call-btn" onClick={toggleMicMute} title={micEnabled ? t('muteMic') : t('unmuteMic')}>{micEnabled ? '🎙️' : '🔇'}</button>}
          {roomId && !waitingForApproval && <button className={`top-call-btn ${cameraOpen ? 'active' : ''}`} onClick={() => { if (cameraOpen) toggleCameraOverlay(cameraMode).catch(() => undefined); else setCameraModeChoiceOpen(true); }} title={t('cameraSettings')}>📷</button>}
          <button className="settings-icon-btn" onClick={() => setSettingsOpen(true)} title={t('settingsPanel')}>⚙</button>
          <button className="profile-chip" onClick={() => setProfileModalOpen(true)} title={t('profileSettings')}>
            <span className="profile-avatar-mini">{profile.avatar_data_url ? <img src={profile.avatar_data_url} alt="avatar" /> : profile.display_name.slice(0, 1).toUpperCase()}</span>
            <span>{profile.display_name}</span>
          </button>
          <div className="brand-mini" data-tauri-drag-region><strong>MHTalk</strong><span>{t('privateP2PRoom')}</span></div>
          <button className="win-btn" onClick={minimizeWindow} title={t('minimizeTitle')}>—</button>
          <button className="win-btn" onClick={toggleMaximizeWindow} title={t('maximizeTitle')}>□</button>
          <button className="win-btn" onClick={hideToTray} title={t('trayTitle')}>▾</button>
          <button className="win-btn close" onClick={() => closeWindow()} title={t('closeTitle')}>×</button>
        </div>
      </header>

      {toast && <div className="toast">{toast}</div>}

      <section className={`layout ${roomId ? '' : 'home-layout'}`}>
        <section className="panel main-panel">
          {!roomId ? (
            <div className="home">
              <h2>{t('startRoom')}</h2>
              <p>{t('startRoomDesc')}</p>
              <button className="primary big" disabled={busy} onClick={createRoom}>{t('createRoom')}</button>
              <div className="join-box">
                <input data-allow-context="true" placeholder="MHLKO-7K9A-X2QF" value={joinCode} onChange={(e) => setJoinCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && joinRoom()} />
                <button disabled={busy} onClick={joinRoom}>{t('joinRoom')}</button>
              </div>
            </div>
          ) : (
            <div className="room">
              <div className="room-head compact">
                <div>
                  <span className="mini">{t('roomId')}{isRoomOwner ? ` • ${t('adminBadge')}` : ownerPeerId ? '' : ''}</span>
                  <h2 className="room-code-line" data-allow-context="true"><span>{roomId}</span><button className="copy-room-icon" onClick={copyRoomId} title={roomCopied ? t('copied') : t('copyCode')} aria-label={roomCopied ? t('copied') : t('copyCode')}>{roomCopied ? '✓' : '📋'}</button></h2>
                </div>
                <div className="actions">
                  {isRoomOwner && peerList.length > 0 && <button onClick={muteAllMembers}>{globalMuteActive ? t('unmuteAllMembers') : t('muteAllMembers')}</button>}
                  {forcedMutedByAdmin && !isRoomOwner && <button onClick={requestToSpeak}>✋ {t('raiseHand')}</button>}
                  {roomId && !waitingForApproval && <button onClick={toggleChatOverlay}>{chatOverlayOpen ? t('hideChatOverlay') : t('showChatOverlay')}</button>}
                  <button className="danger" onClick={() => leaveRoom(true)}>{t('endCall')}</button>
                </div>
              </div>

              {waitingForApproval ? (
                <div className="approval-wait-screen">
                  <div className="m-loader"><span>M</span><i /><i /><i /></div>
                  <h3>{t('waitingApprovalTitle')}</h3>
                  <p>{t('waitingApprovalDesc')}</p>
                </div>
              ) : <>
              <div className={`top-stage ${mediaPanelOpen ? 'viewer-open' : 'viewer-hidden'}`}>
                {mediaPanelOpen && <div className="media-box" ref={mediaBoxRef}>
                  <MediaVideo stream={streamViewerOpen ? activeStream : undefined} active={streamViewerOpen && activeHasMedia} videoRef={activeVideoRef} audioEnabled={Boolean(activePeer?.peerId && pipPeerId === activePeer.peerId)} muted={activePeerVolume.screenMuted} volume={activePeerVolume.screen} outputId={settings.audioOutputId} refreshToken={activePeer?.peerId ? streamRefreshTokens[activePeer.peerId] || 0 : 0} />
                  {streamViewerOpen && <div className="screen-overlay"><button onClick={toggleFullscreen}>{isFullscreen ? t('exitFullscreen') : t('fullscreen')}</button><button onClick={openPictureInPicture}>{t('pip')}</button><button onClick={restartWatchedStream}>{t('restartWatchedStream')}</button><button onClick={closeCurrentStream}>{t('closeStream')}</button>{activePeer?.peerId && (() => { const volume = peerVolumes[activePeer.peerId] || defaultVolume(); return <div className={`stream-volume-control ${streamVolumeOpen ? 'open' : ''}`}><button onClick={() => setStreamVolumeOpen((open) => !open)} title={t('streamVolume')}>{volume.screenMuted ? '🔇' : '🔊'}</button><div className="stream-volume-pop"><button className="tiny-mute" onClick={() => setVolume(activePeer.peerId, 'screenMuted', !volume.screenMuted)}>{volume.screenMuted ? t('unmuteScreen') : t('muteScreen')}</button><input type="range" min="0" max="2" step="0.05" value={volume.screen} onChange={(e) => setVolume(activePeer.peerId, 'screen', Number(e.target.value))} /><small>{Math.round(volume.screen * 100)}%</small></div></div>; })()}</div>}
                  {!streamViewerOpen && localCameraPanelOpen && <div className="camera-only-stage"><span>{t('cameraOnly')}</span></div>}
                  {cameraOpen && cameraStream && cameraMode === 'camera-only' && <div className="camera-overlay-box" style={{ left: `${cameraBox.x}%`, top: `${cameraBox.y}%`, width: `${cameraBox.width}%`, height: `${cameraBox.height}%`, borderRadius: `${settings.cameraOverlay.borderRadius}px` }} onPointerDown={(event) => startCameraDrag(event, 'move')}>
                    <video ref={cameraVideoRef} autoPlay playsInline muted className={settings.cameraOverlay.mirror ? 'mirrored-camera' : ''} />
                    <button className="camera-close" onPointerDown={(e) => e.stopPropagation()} onClick={() => toggleCameraOverlay(cameraMode)}>×</button>
                    <span className="camera-resize" onPointerDown={(event) => startCameraDrag(event, 'resize')} />
                  </div>}
                </div>}

                <div className="member-circles">
                  <div className={`member-circle self local-member ${screenSharing || cameraOpen ? 'streaming-member' : ''} ${screenSharing && cameraOpen ? 'media-both' : cameraOpen ? 'media-camera' : screenSharing ? 'media-screen' : ''} ${memberIsMuted(localPeerId) ? 'muted-member' : ''}`} title={profile.display_name} onContextMenu={(event) => { if (!(screenSharing || cameraOpen)) return; event.preventDefault(); event.stopPropagation(); setSelfMediaMenu({ x: event.clientX, y: event.clientY }); }}>
                    {renderAvatar({ peerId: localPeerId, displayName: profile.display_name, avatar: profile.avatar_data_url })}
                    <small>{t('me')}</small>
                    {(screenSharing || cameraOpen) && <b>{cameraOpen && !screenSharing ? t('cameraOnly') : t('liveBadge')}</b>}{isRoomOwner ? <b>{t('adminBadge')}</b> : roomRoles[localPeerId] === 'moderator' ? <b>{t('moderatorBadge')}</b> : null}
                  </div>
                  {peerList.length === 0 ? <span className="mini waiting-member">{t('waitingForMembers')}</span> : peerList.map((peer) => {
                    const isStreaming = Boolean(peerMedia[peer.peerId]?.screenSharing || peerMedia[peer.peerId]?.cameraSharing);
                    const hasScreen = Boolean(peerMedia[peer.peerId]?.screenSharing);
                    const hasCamera = Boolean(peerMedia[peer.peerId]?.cameraSharing);
                    const action = streamActionLabel(peer.peerId);
                    const mediaClass = hasScreen && hasCamera ? 'media-both' : hasCamera ? 'media-camera' : hasScreen ? 'media-screen' : '';
                    return <div key={peer.peerId} role="button" tabIndex={0} className={`member-circle ${activePeerId === peer.peerId && streamViewerOpen ? 'active' : ''} ${isStreaming ? `streaming-member ${mediaClass}` : ''} ${memberIsMuted(peer.peerId) ? 'muted-member' : ''}`} onClick={() => { if (hasScreen && hasCamera) setPeerMenuId(peer.peerId); else if (hasScreen) showPeerStream(peer.peerId); else if (hasCamera) showPeerCamera(peer.peerId); }} onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && isStreaming) { if (hasScreen && hasCamera) setPeerMenuId(peer.peerId); else if (hasScreen) showPeerStream(peer.peerId); else if (hasCamera) showPeerCamera(peer.peerId); } }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setPeerMenuId(peer.peerId); }} title={peer.displayName}>
                      {renderAvatar(peer)}
                      <small>{peer.displayName}</small>
                      {isStreaming && <b>{hasCamera && !hasScreen ? t('cameraOnly') : hasScreen && hasCamera ? t('cameraWithStream') : t('liveBadge')}</b>}{adminMutedPeers[peer.peerId] && <em className="admin-muted-badge">{t('memberMutedByAdmin')}</em>}{roomRoles[peer.peerId] === 'moderator' && <b>{t('moderatorBadge')}</b>}
                      {action && <button className="stream-card-action" onClick={(event) => { event.stopPropagation(); activePeerId === peer.peerId && streamViewerOpen ? closeCurrentStream() : hasScreen ? showPeerStream(peer.peerId) : showPeerCamera(peer.peerId); }}>{activePeerId === peer.peerId && streamViewerOpen ? t('closeStream') : action}</button>}
                    </div>;
                  })}
                </div>
                {peerMenuId && peers[peerMenuId] && (() => { const peer = peers[peerMenuId]; const volume = peerVolumes[peer.peerId] || defaultVolume(); const action = streamActionLabel(peer.peerId); return <div className="member-popover"><div className="member-popover-head">{renderAvatar(peer)}<strong>{peer.displayName}</strong><button onClick={() => setPeerMenuId('')}>×</button></div>{peerMedia[peer.peerId]?.screenSharing && <button onClick={() => showPeerStream(peer.peerId)}>{t('viewStream')}</button>}{peerMedia[peer.peerId]?.cameraSharing && <button onClick={() => showPeerCamera(peer.peerId)}>{t('viewCamera')}</button>}{action && activePeerId === peer.peerId && streamViewerOpen && <button onClick={closeCurrentStream}>{t('closeStream')}</button>}<button onClick={() => { setPrivateTarget(peer.peerId); setPeerMenuId(''); }}>{t('privateMessage')}</button>{canModerate && peer.peerId !== localPeerId && <button onClick={() => togglePublicMutePeer(peer.peerId)}>{adminMutedPeers[peer.peerId] ? t('unmuteForEveryone') : t('muteForEveryone')}</button>}{canModerate && peer.peerId !== localPeerId && <button className="danger" onClick={() => kickPeer(peer.peerId)}>{t('kickMember')}</button>}{isRoomOwner && roomRoles[peer.peerId] !== 'moderator' && <button onClick={() => promotePeer(peer.peerId)}>{t('promoteModerator')}</button>}<label>{t('callVolume')} {Math.round(volume.voice * 100)}%</label><input type="range" min="0" max="2" step="0.05" value={volume.voice} onChange={(e) => setVolume(peer.peerId, 'voice', Number(e.target.value))} /><button onClick={() => setVolume(peer.peerId, 'voiceMuted', !volume.voiceMuted)}>{volume.voiceMuted ? t('unmuteCall') : t('muteCall')}</button><label>{t('screenVolume')} {Math.round(volume.screen * 100)}%</label><input type="range" min="0" max="2" step="0.05" value={volume.screen} onChange={(e) => setVolume(peer.peerId, 'screen', Number(e.target.value))} /><button onClick={() => setVolume(peer.peerId, 'screenMuted', !volume.screenMuted)}>{volume.screenMuted ? t('unmuteScreen') : t('muteScreen')}</button></div>; })()}
              </div>

              <div className="chat">
                <div className={`messages chat-drop-zone${draggingAttachments ? ' dragging' : ''}`} onDragOver={handleChatDragOver} onDragLeave={handleChatDragLeave} onDrop={handleChatDrop}>
                  {messages.map((message) => (
                    <div
                      key={message.id}
                      ref={(node) => { messageRefs.current[message.id] = node; }}
                      data-message-id={message.id}
                      className={`msg ${message.sender} ${message.kind || 'text'} ${highlightedMessageId === message.id ? 'highlight' : ''}`}
                    >
                      <span>{message.senderName}{message.privateTo || message.privateFrom ? ` • ${t('privateLabel')}` : ''}{message.editedAt ? ` • ${t('edited')}` : ''}</span>
                      {message.replyToId && <button className="reply-preview clickable" onClick={() => scrollToMessage(message.replyToId)}><b>{message.replyToSender}</b><em>{message.replyToBody}</em></button>}
                      {renderMessageContent(message, { onImageOpen: setImagePreview, onMediaContextMenu: openMediaContext, onFileMenu: openFileContext, t })}
                      {message.sender === 'me' && !message.deletedAt && !['sending', 'failed', 'canceled'].includes(message.fileStatus || '') && <div className={`delivery-status ${message.deliveryStatus === 'seen' ? 'seen' : ''}`}>
                        <span>{message.deliveryStatus === 'sending' ? '…' : message.deliveryStatus === 'sent' ? '✓' : '✓✓'}</span> {messageStatusText(message)}
                      </div>}
                      {message.sender !== 'system' && !message.deletedAt && <div className="msg-actions"><button className="reply-btn" onClick={() => { setEditingMessage(null); setReplyTo(message); }}>{t('reply')}</button>{message.sender === 'me' && message.kind === 'text' && <button className="reply-btn" onClick={() => beginEditMessage(message)}>{t('edit')}</button>}{message.sender === 'me' && <button className="reply-btn danger-mini" onClick={() => deleteChatMessage(message)}>{t('deleteMessage')}</button>}</div>}
                    </div>
                  ))}
                  <div ref={chatEndRef} />
                </div>
                <div className="composer-wrap">
                  {privateTarget && <div className="private-bar">{t('privateTo')} {privateTargetName()} <button onClick={() => setPrivateTarget('')}>{t('cancel')}</button></div>}
                  {editingMessage && <div className="private-bar edit-bar">{t('editingMessage')}: {editingMessage.body} <button onClick={cancelEdit}>{t('cancel')}</button></div>}
                  {replyTo && !editingMessage && <div className="private-bar reply-bar">{t('replyTo')} {replyTo.senderName}: {messagePreviewText(replyTo)} <button onClick={() => setReplyTo(null)}>{t('cancel')}</button></div>}
                  {showEmoji && <div className="emoji-box">{EMOJIS.map((emoji) => <button key={emoji} onClick={() => { setDraft((current) => current + emoji); setShowEmoji(false); window.setTimeout(() => messageInputRef.current?.focus(), 0); }}>{emoji}</button>)}</div>}
                  {typingNames.length > 0 && <div className="typing-indicator">{typingLabel()}</div>}
                  {pendingVoice && <div className="voice-preview-card"><span>{t('voicePreview')}</span><div className="waveform">{pendingVoice.waveform.map((bar, index) => <i key={index} style={{ height: `${Math.max(8, Math.round(bar * 34))}px` }} />)}</div><audio className="hidden-audio voice-message-audio" src={pendingVoice.dataUrl} controls={false} hidden aria-hidden="true" tabIndex={-1} style={{ display: 'none' }} /><button onClick={() => setPendingVoice(null)}>{t('discardVoice')}</button></div>}
                  {pendingAttachments.length > 0 && <div className="pending-attachments">{pendingAttachments.map((item) => <div key={item.id} className="pending-card">{item.preview && item.file.type.startsWith('image/') ? <img src={item.preview} alt={item.file.name} /> : item.preview && item.file.type.startsWith('video/') ? <video src={item.preview} muted playsInline preload="metadata" /> : <span>{item.file.type.startsWith('video/') ? '🎬' : item.file.type.startsWith('audio/') ? '🎙️' : '📄'}</span>}<small>{formatBytes(item.file.size)}</small><button onClick={() => cancelPendingAttachment(item.id)}>×</button></div>)}</div>}
                  <div className="composer">
                    <input ref={attachInputRef} type="file" className="hidden-file" onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.currentTarget.value = '';
                      if (file) await queueAttachment(file);
                    }} />
                    <button title={t('emojiTitle')} onClick={() => setShowEmoji((value) => !value)}>😀</button>
                    <button title={t('attachTitle')} onClick={() => attachInputRef.current?.click()}>📎</button>
                    <button
                      className={recording ? 'danger' : ''}
                      title={t('holdVoiceHint')}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* optional */ }
                        startVoiceRecording().catch(() => undefined);
                      }}
                      onPointerUp={stopVoiceRecordingPreview}
                      onPointerCancel={stopVoiceRecordingPreview}
                      onLostPointerCapture={() => {
                        if (recording || voiceRecordStartInFlightRef.current) stopVoiceRecordingPreview();
                      }}
                    >{recording ? '■' : '🎙️'}</button>
                    <textarea data-allow-context="true" ref={messageInputRef} rows={1} value={draft} placeholder={privateTarget ? `${t('privateTo')} ${privateTargetName()}...` : t('writeMessage')} onPaste={handlePaste} onChange={handleDraftChange} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } }} />
                    <button onClick={sendChat}>{editingMessage ? t('saveEdit') : t('send')}</button>
                  </div>
                </div>
              </div>
              </>}
            </div>
          )}
        </section>

        {settingsOpen && <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="profile-modal settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h3>{t('settingsPanel')}</h3><button onClick={() => setSettingsOpen(false)}>×</button></div>
            <label>{t('language')}</label>
            <select value={settingsForm.language} onChange={(e) => updateDraftSettings({ language: e.target.value as AppLanguage })}>
              {LANGUAGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <button className="screen-recorder-open-btn" onClick={() => openScreenRecorderPanel().catch(() => undefined)}>
              <span className="screen-recorder-button-icon">●</span>
              <span><strong>{t('screenRecorder')}</strong><small>{t('screenRecorderSettingsOnly')}</small></span>
              {recoverableScreenRecordings.length > 0 && <em>{recoverableScreenRecordings.length}</em>}
            </button>
            <div className="toggle-row"><span>{t('notifications')}</span><input type="checkbox" checked={settingsForm.notificationsEnabled} onChange={(e) => updateDraftSettings({ notificationsEnabled: e.target.checked })} /></div>
            <button onClick={refreshDevices}>{t('refreshAudio')}</button>
            <label>{t('mic')}</label>
            <select value={settingsForm.audioInputId} onChange={(e) => updateDraftSettings({ audioInputId: e.target.value })}>
              <option value="">{t('defaultDevice')}</option>
              {devices.inputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Mic ${device.deviceId.slice(0, 5)}`}</option>)}
            </select>
            <label>{t('speaker')}</label>
            <select value={settingsForm.audioOutputId} onChange={(e) => updateDraftSettings({ audioOutputId: e.target.value })}>
              <option value="">{t('defaultDevice')}</option>
              {devices.outputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Speaker ${device.deviceId.slice(0, 5)}`}</option>)}
            </select>
            <label>{t('cameraSource')}</label>
            <select value={settingsForm.cameraInputId || ''} onChange={(e) => updateDraftSettings({ cameraInputId: e.target.value })}>
              <option value="">{t('defaultDevice')}</option>
              {devices.cameras.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${device.deviceId.slice(0, 5)}`}</option>)}
            </select>
            <div className="mic-test-card">
              <div className="mic-test-head"><strong>{t('micTest')}</strong><button onClick={toggleMicTest}>{micTestActive ? t('micTestStop') : t('micTestStart')}</button></div>
              <p className="mini">{t('micTestHint')}</p>
              <div className="mic-level" title={t('micLevel')}><i style={{ width: `${Math.round(micTestLevel * 100)}%` }} /></div>
            </div>
            {voiceEngineStatus && <div className="mic-test-card native-voice-card hidden-settings-ui">
              <div className="mic-test-head"><strong>{t('nativeVoiceEngine')}</strong><span>{voiceEngineStatus.processName}</span></div>
              <p className="mini">{t('nativeVoiceEngineGroundwork')}</p><p className="mini native-voice-note">{voiceEngineStatus.note}</p>
            </div>}
            <div className={`mic-test-card voice-enhance-card ${settingsForm.voiceEnhanceEnabled ? 'active' : ''}`}>
              <div className="mic-test-head"><strong>{settingsForm.voiceEnhanceEnabled ? t('voiceEnhanceOff') : t('voiceEnhanceOn')}</strong><button onClick={() => updateDraftSettings({ voiceEnhanceEnabled: !settingsForm.voiceEnhanceEnabled })}>{settingsForm.voiceEnhanceEnabled ? t('voiceEnhanceOff') : t('voiceEnhanceOn')}</button></div>
              <p className="mini">{t('voiceEnhanceHint')}</p>
              <span className="voice-enhance-state">{settingsForm.voiceEnhanceEnabled ? t('voiceEnhanceEnabled') : t('voiceEnhanceDisabled')}</span>
            </div>
            {screenSharing && <p className="mini echo-guard-note">{t('echoGuardActive')}</p>}
            <label>{t('screenQuality')}</label>
            <select value={settingsForm.screenQuality} onChange={(e) => updateDraftSettings({ screenQuality: e.target.value as ScreenQuality })}>
              {availableQualityOptions.map((quality) => <option key={quality} value={quality}>{quality === 'auto-max' ? t('autoMaxQuality') : quality === 'audio-only' ? t('audioOnly') : quality.toUpperCase()}</option>)}
            </select>
            <label>{t('screenFps')}</label>
            <select value={settingsForm.screenFps} onChange={(e) => updateDraftSettings({ screenFps: Number(e.target.value) as ScreenFps })}>
              {availableFpsOptions.map((fps) => <option key={fps} value={fps}>{fps} FPS</option>)}
            </select>
            <button className="overlay-editor-open" onClick={() => { setOverlayDraft(clampOverlaySettings(settingsForm.chatOverlay)); setOverlayEditorOpen(true); }}>{t('chatOverlayCustomize')}</button><button className="overlay-editor-open" onClick={() => { setCameraDraft(clampCameraSettings(settingsForm.cameraOverlay)); setCameraSettingsOpen(true); }}>{t('cameraOverlayCustomize')}</button>
            <div className="toggle-row"><span>{t('saveChat')}</span><input type="checkbox" checked={settingsForm.saveChat} onChange={(e) => updateDraftSettings({ saveChat: e.target.checked })} /></div>
            <div className="toggle-row"><span>{t('historyForNewMembers')}</span><input type="checkbox" checked={Boolean(settingsForm.showHistoryForNewMembers)} onChange={(e) => updateDraftSettings({ showHistoryForNewMembers: e.target.checked })} /></div>
            <div className="toggle-row"><span>{t('lowInternet')}</span><input type="checkbox" checked={settingsForm.lowInternetMode} onChange={(e) => updateDraftSettings({ lowInternetMode: e.target.checked })} /></div>
            <div className="toggle-row"><span>{t('lowPc')}</span><input type="checkbox" checked={settingsForm.lowPcMode} onChange={(e) => updateDraftSettings({ lowPcMode: e.target.checked })} /></div>
            <div className="settings-modal-actions"><button className={`apply-settings-btn ${settingsDirty ? 'dirty' : 'clean'}`} onClick={applySettingsChanges}>{t('applySettings')}</button><button onClick={() => checkForUpdates(true)} disabled={updateBusy}>{updateBusy ? t('checkingUpdates') : t('checkUpdates')}</button><button onClick={() => setHotkeysOpen(true)}>{t('hotkeys')}</button><button onClick={() => setErrorLogOpen(true)}>{t('errorLog')}</button>{canModerate && <button onClick={openBannedMembers}>{t('bannedMembers')}</button>}<button onClick={clearCurrentChat} disabled={!roomId}>{t('deleteRoomHistory')}</button><button className="danger" onClick={wipeData}>{t('deleteAllLocalData')}</button></div>
            {updateProgress && <p className="mini update-progress">{updateProgress}</p>}
            <h3 className="side-title hidden-settings-ui">{t('friendsInRoom')}</h3>
            <div className="peer-list settings-peer-list hidden-settings-ui">
              {peerList.length === 0 && <p className="mini">{t('nobody')}</p>}
              {peerList.map((peer) => { const volume = peerVolumes[peer.peerId] || defaultVolume(); const action = streamActionLabel(peer.peerId); return <div key={peer.peerId} className="peer-control"><button className="peer-control-head" onContextMenu={(event) => { event.preventDefault(); setPeerMenuId(peer.peerId); }} onClick={() => setPeerMenuId(peerMenuId === peer.peerId ? '' : peer.peerId)}>{renderAvatar(peer)}<span>{peer.displayName}</span></button>{peerMenuId === peer.peerId && <div className="peer-menu">{peerMedia[peer.peerId]?.screenSharing && <button onClick={() => showPeerStream(peer.peerId)}>{t('viewStream')}</button>}{peerMedia[peer.peerId]?.cameraSharing && <button onClick={() => showPeerCamera(peer.peerId)}>{t('viewCamera')}</button>}{action && activePeerId === peer.peerId && streamViewerOpen && <button onClick={closeCurrentStream}>{t('closeStream')}</button>}<button onClick={() => { setPrivateTarget(peer.peerId); setPeerMenuId(''); }}>{t('privateMessage')}</button>{canModerate && peer.peerId !== localPeerId && <button onClick={() => togglePublicMutePeer(peer.peerId)}>{adminMutedPeers[peer.peerId] ? t('unmuteForEveryone') : t('muteForEveryone')}</button>}{canModerate && peer.peerId !== localPeerId && <button className="danger" onClick={() => kickPeer(peer.peerId)}>{t('kickMember')}</button>}{isRoomOwner && roomRoles[peer.peerId] !== 'moderator' && <button onClick={() => promotePeer(peer.peerId)}>{t('promoteModerator')}</button>}<label>{t('callVolume')} {Math.round(volume.voice * 100)}%</label><input type="range" min="0" max="2" step="0.05" value={volume.voice} onChange={(e) => setVolume(peer.peerId, 'voice', Number(e.target.value))} /><button onClick={() => setVolume(peer.peerId, 'voiceMuted', !volume.voiceMuted)}>{volume.voiceMuted ? t('unmuteCall') : t('muteCall')}</button><label>{t('screenVolume')} {Math.round(volume.screen * 100)}%</label><input type="range" min="0" max="2" step="0.05" value={volume.screen} onChange={(e) => setVolume(peer.peerId, 'screen', Number(e.target.value))} /><button onClick={() => setVolume(peer.peerId, 'screenMuted', !volume.screenMuted)}>{volume.screenMuted ? t('unmuteScreen') : t('muteScreen')}</button></div>}</div>; })}
            </div>
          </div>
        </div>}


        {micJoinPromptOpen && <div className="modal-backdrop"><div className="profile-modal mic-join-modal" onClick={(e) => e.stopPropagation()}><div className="modal-head"><h3>{t('micJoinTitle')}</h3></div><p className="mini">{t('micJoinDesc')}</p><div className="settings-modal-actions"><button className="primary" onClick={() => chooseRoomMic(true)}>{t('activateMicNow')}</button><button onClick={() => chooseRoomMic(false)}>{t('stayMuted')}</button></div></div></div>}

        {screenRecorderOpen && <div className="modal-backdrop screen-recorder-backdrop" onClick={() => setScreenRecorderOpen(false)}>
          <div className="profile-modal screen-recorder-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div><h3>{t('screenRecorderTitle')}</h3><p className="mini">{t('screenRecorderSettingsOnly')}</p></div>
              <button onClick={() => setScreenRecorderOpen(false)}>×</button>
            </div>

            <div className="screen-recorder-settings-grid">
              <label><span>{t('screenRecorderQuality')}</span><select value={screenRecorderDraft.quality} onChange={(e) => setScreenRecorderDraft((current) => ({ ...current, quality: e.target.value as ScreenRecorderSettings['quality'] }))}><option value="adaptive">{t('screenRecorderQualityAdaptive')}</option><option value="high">{t('screenRecorderQualityHigh')}</option><option value="balanced">{t('screenRecorderQualityBalanced')}</option><option value="performance">{t('screenRecorderQualityPerformance')}</option></select></label>
              <label><span>{t('screenRecorderFps')}</span><select value={screenRecorderDraft.fps} onChange={(e) => setScreenRecorderDraft((current) => ({ ...current, fps: e.target.value === 'match' ? 'match' : Number(e.target.value) as ScreenRecorderSettings['fps'] }))}><option value="match">{t('screenRecorderFpsMatch')}</option><option value="60">60 FPS</option><option value="30">30 FPS</option><option value="15">15 FPS</option></select></label>
              <label><span>{t('screenRecorderCodec')}</span><select value={screenRecorderDraft.codec} onChange={(e) => setScreenRecorderDraft((current) => ({ ...current, codec: e.target.value as ScreenRecorderSettings['codec'] }))}><option value="auto">{t('screenRecorderCodecAuto')}</option><option value="h264">H.264 / MP4</option><option value="vp8">VP8</option><option value="vp9">VP9</option></select></label>
              <label><span>{t('recorderMicDevice')}</span><select value={screenRecorderDraft.micDeviceId} onChange={(e) => setScreenRecorderDraft((current) => ({ ...current, micDeviceId: e.target.value }))}><option value="">{t('defaultDevice')}</option>{devices.inputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || device.deviceId.slice(0, 8)}</option>)}</select></label>
              <label><span>{t('recorderOutputDevice')}</span><select value={screenRecorderDraft.outputDeviceId} onChange={(e) => setScreenRecorderDraft((current) => ({ ...current, outputDeviceId: e.target.value }))}><option value="">{t('defaultDevice')}</option>{devices.outputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || device.deviceId.slice(0, 8)}</option>)}</select></label>
              <div className="screen-recorder-switches">
                <label className="toggle-row"><span>{t('screenRecorderIncludeAudio')}</span><input type="checkbox" checked={screenRecorderDraft.includeAudio} onChange={(e) => setScreenRecorderDraft((current) => ({ ...current, includeAudio: e.target.checked }))} /></label>
                <label className="toggle-row"><span>{t('screenRecorderAutoStart')}</span><input type="checkbox" checked={screenRecorderDraft.autoStart} onChange={(e) => setScreenRecorderDraft((current) => ({ ...current, autoStart: e.target.checked }))} /></label>
              </div>
            </div>

            {screenRecorderDraft.includeAudio && <div className="recorder-mixer">
              {([
                ['mic', 'includeMic', 'micVolume', t('recorderMyMic')],
                ['members', 'includeMembers', 'membersVolume', t('recorderMembers')],
                ['system', 'includeSystem', 'systemVolume', t('recorderSystem')]
              ] as const).map(([levelKey, enabledKey, volumeKey, label]) => <div className="recorder-mixer-row" key={levelKey}>
                <button className={screenRecorderDraft[enabledKey] ? 'source-enabled' : 'source-muted'} title={t('recorderMuteSource')} onClick={() => setScreenRecorderDraft((current) => ({ ...current, [enabledKey]: !current[enabledKey] }))}>{screenRecorderDraft[enabledKey] ? '🔊' : '🔇'}</button>
                <strong>{label}</strong>
                <input type="range" min="0" max="2" step="0.01" disabled={!screenRecorderDraft[enabledKey]} value={screenRecorderDraft[volumeKey]} onChange={(event) => setScreenRecorderDraft((current) => ({ ...current, [volumeKey]: Number(event.target.value) }))} />
                <span>{Math.round(screenRecorderDraft[volumeKey] * 100)}%</span>
                <div className="recorder-level-meter"><i style={{ width: `${Math.round(screenRecorderLevels[levelKey] * 100)}%` }} /></div>
              </div>)}
              <label className="toggle-row recorder-auto-duck"><span>{t('recorderAutoDuck')}</span><input type="checkbox" checked={screenRecorderDraft.autoDuckSystem} onChange={(e) => setScreenRecorderDraft((current) => ({ ...current, autoDuckSystem: e.target.checked }))} /></label>
              <div className="recorder-master-level"><span>{t('recorderMasterMeter')}</span><div className="recorder-level-meter"><i style={{ width: `${Math.round(screenRecorderLevels.mixed * 100)}%` }} /></div></div>
            </div>}

            <p className="screen-recorder-note">{t('screenRecorderPerformanceNote')}</p>
            <p className="screen-recorder-note mp4-note">{t('screenRecorderMp4Hint')}</p>
            <div className={`screen-recorder-dependency dependency-${screenRecorderDependency.state}`}>
              <span>{screenRecorderDependency.state === 'ready' ? '✓' : screenRecorderDependency.state === 'error' ? '!' : '…'}</span>
              <strong>{screenRecorderDependency.state === 'ready' ? t('screenRecorderDependencyReady') : screenRecorderDependency.state === 'error' ? t('screenRecorderDependencyFailed') : t('screenRecorderDependencyPreparing')}</strong>
              {screenRecorderDependency.state === 'error' && screenRecorderDependency.message && <small>{screenRecorderDependency.message}</small>}
            </div>
            {screenRecorderFinalization && <p className="screen-recorder-note finalization-note">{screenRecorderFinalization}</p>}
            {screenRecorderError && <p className="screen-recorder-error">{screenRecorderError}</p>}
            {screenRecorderSavedPath && <div className="screen-recorder-path"><span>{t('screenRecorderFile')}</span><code>{screenRecorderSavedPath}</code></div>}

            <div className="screen-recorder-actions">
              <button className="primary" onClick={saveScreenRecorderSettings}>{t('screenRecorderSaveSettings')}</button>
              <button className={recoverableScreenRecordings.length > 0 ? 'recovery-attention' : ''} onClick={() => openScreenRecorderRecoveryPanel().catch(() => undefined)}>{t('screenRecorderRepair')}{recoverableScreenRecordings.length > 0 ? ` (${recoverableScreenRecordings.length})` : ''}</button>
              <button onClick={openScreenRecorderFolder}>{t('screenRecorderOpenFolder')}</button>
              <button onClick={() => setScreenRecorderOpen(false)}>{t('cancel')}</button>
            </div>
          </div>
        </div>}

        {screenRecorderRecoveryOpen && <div className="modal-backdrop screen-recorder-backdrop" onClick={() => !screenRecorderRecoveryBusy && setScreenRecorderRecoveryOpen(false)}>
          <div className="profile-modal screen-recorder-recovery-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div><h3>{t('screenRecorderRepairTitle')}</h3><p className="mini">{t('screenRecorderRepairHint')}</p></div>
              <button disabled={Boolean(screenRecorderRecoveryBusy)} onClick={() => setScreenRecorderRecoveryOpen(false)}>×</button>
            </div>
            <div className="screen-recorder-recovery-list">
              {recoverableScreenRecordings.length === 0 ? <p className="screen-recorder-empty-recovery">{t('screenRecorderNoRecovery')}</p> : recoverableScreenRecordings.map((item) => {
                const busyItem = screenRecorderRecoveryBusy === item.sessionId;
                const activeRecorder = ['recording', 'paused', 'starting', 'stopping'].includes(screenRecorderState);
                return <article key={item.sessionId} className={busyItem ? 'busy' : ''}>
                  <div className="screen-recorder-recovery-info">
                    <strong>{item.displayName}</strong>
                    <span>{t('screenRecorderRecoveryDate')}: {new Date(item.updatedAtMs || item.createdAtMs).toLocaleString()}</span>
                    <span>{t('screenRecorderRecoverySize')}: {formatBytes(item.size)} · {item.segmentCount} {t('screenRecorderRecoverySegments')}</span>
                  </div>
                  <div className="screen-recorder-recovery-actions">
                    <button className="primary" disabled={Boolean(screenRecorderRecoveryBusy) || activeRecorder} onClick={() => resumeRecoverableRecording(item)}>{busyItem ? t('screenRecorderFinalizingMp4') : t('screenRecorderResumePrevious')}</button>
                    <button className="danger" disabled={Boolean(screenRecorderRecoveryBusy) || activeRecorder} onClick={() => finalizeRecoverableRecording(item)}>{busyItem ? t('screenRecorderFinalizingMp4') : t('screenRecorderStopAndSaveMp4')}</button>
                  </div>
                </article>;
              })}
            </div>
          </div>
        </div>}


        {cameraModeChoiceOpen && <div className="modal-backdrop" onClick={() => setCameraModeChoiceOpen(false)}><div className="profile-modal camera-mode-modal" onClick={(e) => e.stopPropagation()}><div className="modal-head"><h3>{t('cameraModeTitle')}</h3><button onClick={() => setCameraModeChoiceOpen(false)}>×</button></div><p className="mini">{t('cameraModeHint')}</p><div className="camera-mode-actions"><button className="primary" onClick={() => { setCameraMode('camera-only'); setCameraModeChoiceOpen(false); toggleCameraOverlay('camera-only').catch(() => undefined); }}>{t('cameraOnlyMode')}</button><button onClick={() => { setCameraMode('camera-with-stream'); setCameraDraft(settings?.cameraOverlay || DEFAULT_CAMERA_OVERLAY); setCameraModeChoiceOpen(false); setCameraSettingsOpen(true); }}>{t('cameraWithStream')}</button></div></div></div>}

        {cameraSettingsOpen && (() => { const draft = clampCameraSettings(cameraDraft || settingsForm.cameraOverlay || DEFAULT_CAMERA_OVERLAY); return <div className="modal-backdrop" onClick={() => setCameraSettingsOpen(false)}><div className="profile-modal overlay-editor-modal camera-settings-modal" onClick={(e) => e.stopPropagation()}><div className="modal-head"><h3>{t('cameraEditorTitle')}</h3><button onClick={() => setCameraSettingsOpen(false)}>×</button></div><p className="mini">{cameraMode === 'camera-with-stream' ? t('cameraEditorHint') : t('cameraModeHint')}</p><label>{t('cameraSource')}</label><select value={draftSettings?.cameraInputId ?? settings?.cameraInputId ?? ''} onChange={(e) => updateDraftSettings({ cameraInputId: e.target.value })}><option value="">{t('defaultDevice')}</option>{devices.cameras.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${device.deviceId.slice(0, 5)}`}</option>)}</select><div className="overlay-screen-mock"><div className="overlay-edit-box camera-edit-box" style={{ left: `${draft.xPercent}%`, top: `${draft.yPercent}%`, width: `${draft.widthPercent}%`, height: `${draft.heightPercent}%`, borderRadius: `${draft.borderRadius}px`, opacity: draft.opacity }} onPointerDown={(event) => cameraMockPointer(event, 'move')}>{(cameraOpen ? cameraStream : cameraSetupPreviewStream) && <LocalMediaPreview stream={cameraOpen ? cameraStream : cameraSetupPreviewStream} className={`camera-composition-preview ${draft.mirror ? 'mirrored-camera' : ''}`} style={{ objectFit: draft.fitMode }} />}<span>{t('camera')}</span><em>{t('cameraOverlayCustomize')}</em><i onPointerDown={(event) => cameraMockPointer(event, 'resize')} /></div></div><div className="overlay-controls"><label>{t('overlayBorderRadius')} <input type="range" min="0" max="50" step="1" value={draft.borderRadius} onChange={(e) => updateCameraDraft({ borderRadius: Number(e.target.value) })} /></label><label>{t('cameraOpacity')} <input type="range" min="0.1" max="1" step="0.01" value={draft.opacity} onChange={(e) => updateCameraDraft({ opacity: Number(e.target.value) })} /></label><label>{t('cameraFitMode')}<select value={draft.fitMode} onChange={(e) => updateCameraDraft({ fitMode: e.target.value === 'contain' ? 'contain' : 'cover' })}><option value="cover">{t('cameraFitCover')}</option><option value="contain">{t('cameraFitContain')}</option></select></label>{draft.fitMode === 'cover' && <><label>{t('cameraCropX')} <input type="range" min="0" max="100" step="1" value={draft.cropXPercent} onChange={(e) => updateCameraDraft({ cropXPercent: Number(e.target.value) })} /></label><label>{t('cameraCropY')} <input type="range" min="0" max="100" step="1" value={draft.cropYPercent} onChange={(e) => updateCameraDraft({ cropYPercent: Number(e.target.value) })} /></label></>}<label><input type="checkbox" checked={draft.mirror} onChange={(e) => updateCameraDraft({ mirror: e.target.checked })} /> {t('cameraMirror')}</label></div><div className="settings-modal-actions"><button className="primary" onClick={() => toggleCameraOverlay(cameraMode)}>{cameraOpen ? t('cameraStop') : t('cameraStart')}</button><button onClick={saveCameraDraft}>{t('applySettings')}</button><button onClick={() => setCameraDraft(DEFAULT_CAMERA_OVERLAY)}>{t('overlayReset')}</button><button onClick={() => setCameraSettingsOpen(false)}>{t('cancel')}</button></div></div></div>; })()}

        {overlayEditorOpen && (() => { const draft = clampOverlaySettings(overlayDraft || settingsForm.chatOverlay); return <div className="modal-backdrop" onClick={() => setOverlayEditorOpen(false)}><div className="profile-modal overlay-editor-modal" onClick={(e) => e.stopPropagation()}><div className="modal-head"><h3>{t('overlayEditorTitle')}</h3><button onClick={() => setOverlayEditorOpen(false)}>×</button></div><p className="mini">{t('overlayEditorHint')}</p><div className="overlay-screen-mock"><div className="overlay-edit-box" style={{ left: `${draft.xPercent}%`, top: `${draft.yPercent}%`, width: `${draft.widthPercent}%`, height: `${draft.heightPercent}%`, opacity: draft.opacity, borderRadius: `${draft.borderRadius}px` }} onPointerDown={(event) => overlayMockPointer(event, 'move')}><span>MHTalk</span><em>{t('chatOverlayCustomize')}</em><i onPointerDown={(event) => overlayMockPointer(event, 'resize')} /></div></div><div className="overlay-controls"><label>{t('overlayOpacity')} <input type="range" min="0.15" max="1" step="0.01" value={draft.opacity} onChange={(e) => updateOverlayDraft({ opacity: Number(e.target.value) })} /></label><label>{t('overlayBorderRadius')} <input type="range" min="0" max="40" step="1" value={draft.borderRadius} onChange={(e) => updateOverlayDraft({ borderRadius: Number(e.target.value) })} /></label><label><input type="checkbox" checked={draft.showText} onChange={(e) => updateOverlayDraft({ showText: e.target.checked })} /> {t('overlayShowText')}</label><label><input type="checkbox" checked={draft.showImages} onChange={(e) => updateOverlayDraft({ showImages: e.target.checked })} /> {t('overlayShowImages')}</label><label><input type="checkbox" checked={draft.showAudio} onChange={(e) => updateOverlayDraft({ showAudio: e.target.checked })} /> {t('overlayShowAudio')}</label><label><input type="checkbox" checked={draft.interactive} onChange={(e) => updateOverlayDraft({ interactive: e.target.checked })} /> {draft.interactive ? t('overlayInteractive') : t('overlayClickThrough')}</label><label>{t('overlayMonitor')}<select value={draft.monitorName} onChange={(e) => updateOverlayDraft({ monitorName: e.target.value })}><option value="">{t('defaultDevice')}</option>{overlayMonitors.map((monitor) => <option key={monitor.name} value={monitor.name}>{monitor.label}</option>)}</select></label><p className="mini overlay-limit-note">{t('overlayFullscreenLimit')}</p></div><div className="settings-modal-actions"><button className="primary" onClick={saveOverlayDraft}>{t('applySettings')}</button><button onClick={() => setOverlayDraft(DEFAULT_SETTINGS.chatOverlay)}>{t('overlayReset')}</button><button onClick={() => setOverlayEditorOpen(false)}>{t('cancel')}</button></div></div></div>; })()}


        {hotkeysOpen && <div className="modal-backdrop" onClick={() => setHotkeysOpen(false)}><div className="profile-modal hotkey-modal" onClick={(e) => e.stopPropagation()}><div className="modal-head"><h3>{t('hotkeys')}</h3><button onClick={() => setHotkeysOpen(false)}>×</button></div>{(['muteMic','toggleScreen','endCall','toggleFullscreen','toggleSettings','toggleOverlayMode'] as HotkeyAction[]).map((action) => <div className="hotkey-row" key={action}><span>{t(action === 'muteMic' ? 'muteMicHotkey' : action === 'toggleScreen' ? 'shareScreenHotkey' : action === 'endCall' ? 'endCallHotkey' : action === 'toggleFullscreen' ? 'fullscreenHotkey' : action === 'toggleOverlayMode' ? 'overlayModeHotkey' : 'toggleSettingsHotkey')}</span><button onClick={() => setLearningHotkey(action)}>{learningHotkey === action ? t('pressHotkey') : displayHotkey(settings.hotkeys?.[action] || '')}</button><button className="hotkey-clear" title={t('clearHotkey')} onClick={() => clearHotkey(action)}>×</button></div>)}</div></div>}

        {errorLogOpen && <div className="modal-backdrop" onClick={() => setErrorLogOpen(false)}><div className="profile-modal error-log-modal" onClick={(e) => e.stopPropagation()}><div className="modal-head"><h3>{t('errorLog')}</h3><button onClick={() => setErrorLogOpen(false)}>×</button></div><div className="error-log-actions"><button onClick={downloadErrorLog}>{t('downloadLog')}</button><button onClick={() => setErrorLog([])}>{t('clearLog')}</button></div><div className="error-log-list">{errorLog.length === 0 ? <p className="mini">{t('noErrors')}</p> : errorLog.map((entry) => <pre key={entry.id} className={`log-${entry.level}`}>[{new Date(entry.at).toLocaleString()}] {logLevelText(entry.level)}
{localizeLogMessage(entry.message)}</pre>)}</div></div></div>}
      </section>

      {activeScreenAudioPeerId && (() => {
        const volume = peerVolumes[activeScreenAudioPeerId] || defaultVolume();
        return <BoostedAudioSink
          key={`screen-audio-${activeScreenAudioPeerId}`}
          stream={screenStreams[activeScreenAudioPeerId]}
          muted={volume.screenMuted || pipPeerId === activeScreenAudioPeerId}
          volume={volume.screen}
          outputId={settings.audioOutputId}
          refreshToken={streamRefreshTokens[activeScreenAudioPeerId] || 0}
        />;
      })()}

      {joinRequestsOpen && <div ref={joinPopoverRef} className="join-requests-popover">
        <h3>{t('joinRequests')}</h3>
        {(Object.values(joinRequests) as JoinRequest[]).length === 0 && <p className="mini">{t('noJoinRequests')}</p>}
        {(Object.values(joinRequests) as JoinRequest[]).map((request) => <div className="join-request-row" key={request.peerId}><span>{request.displayName}</span><button onClick={() => approveJoin(request.peerId)}>{t('approve')}</button><button className="danger" onClick={() => rejectJoin(request.peerId)}>{t('reject')}</button></div>)}
        {canModerate && Object.values(speakRequests).length > 0 && <><h3>{t('requestToSpeak')}</h3>{Object.values(speakRequests).map((request) => <div className="join-request-row speak-request-row" key={`speak-${request.peerId}`}><span>✋ {request.displayName}</span><button onClick={() => allowToSpeak(request.peerId)}>{t('allowToSpeak')}</button><button className="danger" onClick={() => rejectSpeak(request.peerId)}>{t('rejectSpeakRequest')}</button></div>)}</>}
      </div>}


      {chatOverlayOpen && !chatOverlayExternal && (() => { const config = settings?.chatOverlay || DEFAULT_SETTINGS.chatOverlay; return <div className="broadcast-chat-overlay" style={{ left: `${config.xPercent}%`, top: `${config.yPercent}%`, right: 'auto', bottom: 'auto', width: `${config.widthPercent}%`, height: `${config.heightPercent}%`, opacity: config.opacity, borderRadius: `${config.borderRadius}px` }}>
        {overlayMessages.length === 0 && <div className="overlay-item text"><b>MHTalk</b><span>{t('chatOverlayEmpty')}</span></div>}
        {overlayMessages.map((message, index) => <div key={`${message.senderName}-${index}`} className={`overlay-item ${message.kind || 'text'}`}><b>{message.senderName}</b>{message.kind === 'image' && message.dataUrl ? <img src={message.dataUrl} alt={message.body || 'media'} /> : message.kind === 'audio' ? <span>🎙️ {message.body}</span> : <span>{message.body}</span>}</div>)}
      </div>; })()}

      {mediaContextMenu && <div className="media-context-menu" style={{ left: mediaContextMenu.x, top: mediaContextMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
        <strong>{t('mediaContextTitle')}</strong>
        <button onClick={() => downloadMediaToDesktop(mediaContextMenu)}>{t('mediaDownloadToDesktop')}</button>
      </div>}

      {fileContextMenu && <div className="media-context-menu file-context-menu" style={{ left: fileContextMenu.x, top: fileContextMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
        <strong>{t('fileActions')}</strong>
        <small>{safeDownloadName(fileContextMenu.message)}</small>
        {fileSaveProgress && <div className="file-save-progress"><span>{t('downloadProgress')} {fileSaveProgress.total > 0 ? `${Math.round((fileSaveProgress.written / fileSaveProgress.total) * 100)}%` : ''}</span><i style={{ width: `${fileSaveProgress.total > 0 ? Math.min(100, (fileSaveProgress.written / fileSaveProgress.total) * 100) : 8}%` }} /></div>}
        <button disabled={Boolean(fileSaveProgress)} onClick={() => persistMessageFile(fileContextMenu.message, 'desktop')}>{t('downloadToDesktop')}</button>
        <button disabled={Boolean(fileSaveProgress)} onClick={() => persistMessageFile(fileContextMenu.message, 'save-as')}>{t('saveAs')}</button>
      </div>}

      {selfMediaMenu && <div className="media-context-menu self-context-menu" style={{ left: selfMediaMenu.x, top: selfMediaMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
        <button onClick={() => { setSelfPreviewOpen(true); setSelfMediaMenu(null); }}>{t('previewMyMedia')}</button>
      </div>}

      {selfPreviewOpen && <div className="modal-backdrop" onClick={() => setSelfPreviewOpen(false)}>
        <div className="profile-modal self-preview-modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-head"><h3>{t('myMediaPreview')}</h3><button onClick={() => setSelfPreviewOpen(false)}>×</button></div>
          {!(screenSharing || cameraOpen) && <p className="mini">{t('noSelfMediaPreview')}</p>}
          <div className="self-preview-grid">
            <section>
              <h4>{t('myScreenPreview')}</h4>
              {screenSharing && localScreenStream ? <LocalMediaPreview stream={localScreenStream} className="self-preview-video" /> : <div className="self-preview-empty">{screenSharing ? t('localScreenPreviewHint') : t('stopShare')}</div>}
            </section>
            <section>
              <h4>{t('myCameraPreview')}</h4>
              {cameraOpen && cameraStream ? <LocalMediaPreview stream={cameraStream} className={`self-preview-video ${settings.cameraOverlay.mirror ? 'mirrored-camera' : ''}`} /> : <div className="self-preview-empty">{t('cameraStop')}</div>}
            </section>
            <section className="self-preview-audio">
              <h4>{t('myAudioPreview')}</h4>
              <p className="mini">{micEnabled ? t('unmuteMic') : t('muteMic')}</p>
              <button onClick={toggleMicTest}>{micTestActive ? t('micTestStop') : t('micTestStart')}</button>
              <div className="mic-test-meter"><i style={{ width: `${Math.round(micTestLevel * 100)}%` }} /></div>
            </section>
          </div>
        </div>
      </div>}

      {imagePreview && <div className="modal-backdrop image-modal-backdrop" onClick={() => setImagePreview(null)}>
        <div className="image-modal" onClick={(e) => e.stopPropagation()}>
          <button className="modal-x" onClick={() => setImagePreview(null)}>×</button>
          <img src={imagePreview.src} alt={imagePreview.name || 'image'} />
        </div>
      </div>}

      {banModalOpen && <div className="modal-backdrop" onClick={() => setBanModalOpen(false)}>
        <div className="profile-modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-head"><h3>{t('bannedMembers')}</h3><button onClick={() => setBanModalOpen(false)}>×</button></div>
          <div className="ban-list">
            {bannedMembers.length === 0 && <p className="mini">{t('noBannedMembers')}</p>}
            {bannedMembers.map((member) => <div className="ban-row" key={member.peerId}><span>{member.displayName}</span><button onClick={() => unbanMember(member.peerId)}>{t('unban')}</button></div>)}
          </div>
        </div>
      </div>}

      {profileModalOpen && <div className="modal-backdrop" onClick={() => setProfileModalOpen(false)}>
        <div className="profile-modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-head"><h3>{t('localAccount')}</h3><button onClick={() => setProfileModalOpen(false)}>×</button></div>
          <div className="banner" style={{ backgroundImage: profile.banner_data_url ? `url(${profile.banner_data_url})` : undefined }} />
          <div className="avatar-row modal-avatar">
            <div className="avatar circle">{profile.avatar_data_url ? <img src={profile.avatar_data_url} alt="avatar" /> : profile.display_name.slice(0, 1).toUpperCase()}</div>
            <div><strong>{profile.display_name}</strong><p>{profile.status || 'Online'}</p></div>
          </div>
          <label>{t('name')}</label>
          <input value={profile.display_name} onChange={(e) => updateProfile({ ...profile, display_name: e.target.value })} />
          <label>{t('email')}</label>
          <input value={profile.account_email} placeholder={t('placeholderEmail')} onChange={(e) => updateProfile({ ...profile, account_email: e.target.value })} />
          <label>{t('status')}</label>
          <input value={profile.status} onChange={(e) => updateProfile({ ...profile, status: e.target.value })} />
          <label>{t('bio')}</label>
          <textarea value={profile.bio} rows={3} onChange={(e) => updateProfile({ ...profile, bio: e.target.value })} />
          <div className="file-row">
            <label className="file-btn">{t('avatar')}<input type="file" accept="image/*" onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file && file.size <= MAX_PROFILE_SOURCE_IMAGE_BYTES) await updateProfile({ ...profile, avatar_data_url: await readFileAsDataUrl(file) });
              else if (file) showToast(t('profileImageTooLarge'));
            }} /></label>
            <label className="file-btn">{t('banner')}<input type="file" accept="image/*" onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file && file.size <= MAX_PROFILE_SOURCE_IMAGE_BYTES) await updateProfile({ ...profile, banner_data_url: await readFileAsDataUrl(file) });
              else if (file) showToast(t('profileImageTooLarge'));
            }} /></label>
          </div>
        </div>
      </div>}

      <div className="app-version-badge">v{APP_VERSION}</div>
      <button className="footer-credit" onClick={openInstagram}>MHTalk By: Mohammed Haliko (@m.ed1t)</button>
    </main>
  );
}
