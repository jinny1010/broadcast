// Broadcast Message Extension for SillyTavern
// 여러 채팅에 동일한 메시지를 보내고 자동으로 숨김 처리

import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    getRequestHeaders,
} from '../../../../script.js';

import { extension_settings } from '../../../extensions.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';

const extensionName = 'broadcast-message';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// 기본 설정
const defaultSettings = {
    autoHide: true,
    delayBetweenChats: 2000, // 채팅 간 딜레이 (ms)
};

// 상태 관리
let isProcessing = false;
let selectedChats = [];
let pendingHide = new Map(); // 숨김 대기 중인 메시지 추적

/**
 * 설정 초기화
 */
function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = value;
        }
    }
}

/**
 * 채팅 목록 가져오기
 * @returns {Promise<Array>} 채팅 목록
 */
async function getChatList() {
    try {
        const response = await fetch('/api/chats/all', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
        });
        
        if (!response.ok) {
            throw new Error('Failed to fetch chat list');
        }
        
        return await response.json();
    } catch (error) {
        console.error('[Broadcast] Error fetching chat list:', error);
        return [];
    }
}

/**
 * 특정 캐릭터의 채팅 목록 가져오기
 * @param {string} characterName 캐릭터 이름
 * @returns {Promise<Array>} 채팅 목록
 */
async function getCharacterChats(characterName) {
    try {
        const response = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: characterName }),
        });
        
        if (!response.ok) {
            throw new Error('Failed to fetch character chats');
        }
        
        return await response.json();
    } catch (error) {
        console.error('[Broadcast] Error fetching character chats:', error);
        return [];
    }
}

/**
 * 채팅 선택 UI 열기
 */
async function openChatSelector() {
    if (isProcessing) {
        toastr.warning('이미 브로드캐스트가 진행 중입니다.');
        return;
    }
    
    const chats = await getChatList();
    
    if (chats.length === 0) {
        toastr.info('사용 가능한 채팅이 없습니다.');
        return;
    }
    
    // 모달 HTML 생성
    const modalHtml = `
        <div id="broadcast-modal" class="broadcast-modal">
            <div class="broadcast-modal-content">
                <h3>📢 브로드캐스트 메시지</h3>
                
                <div class="broadcast-chat-list">
                    <div class="broadcast-select-all">
                        <label>
                            <input type="checkbox" id="broadcast-select-all">
                            <span>전체 선택</span>
                        </label>
                    </div>
                    <div id="broadcast-chats-container">
                        ${chats.map((chat, index) => `
                            <div class="broadcast-chat-item">
                                <label>
                                    <input type="checkbox" 
                                           class="broadcast-chat-checkbox" 
                                           data-index="${index}"
                                           data-chat-id="${chat.file_name || chat.chat_id || index}"
                                           data-character="${chat.character_name || chat.name || 'Unknown'}">
                                    <span>${chat.character_name || chat.name || 'Unknown'} - ${chat.file_name || chat.chat_id || ''}</span>
                                </label>
                            </div>
                        `).join('')}
                    </div>
                </div>
                
                <div class="broadcast-message-input">
                    <label for="broadcast-message">보낼 메시지:</label>
                    <textarea id="broadcast-message" rows="4" placeholder="여러 채팅에 보낼 메시지를 입력하세요..."></textarea>
                </div>
                
                <div class="broadcast-options">
                    <label>
                        <input type="checkbox" id="broadcast-auto-hide" ${extension_settings[extensionName].autoHide ? 'checked' : ''}>
                        <span>보낸 메시지와 응답 자동 숨김</span>
                    </label>
                </div>
                
                <div class="broadcast-actions">
                    <button id="broadcast-cancel" class="menu_button">취소</button>
                    <button id="broadcast-send" class="menu_button">전송</button>
                </div>
            </div>
        </div>
    `;
    
    // 모달 추가
    $('body').append(modalHtml);
    
    // 이벤트 바인딩
    $('#broadcast-select-all').on('change', function() {
        $('.broadcast-chat-checkbox').prop('checked', this.checked);
    });
    
    $('#broadcast-cancel').on('click', closeChatSelector);
    
    $('#broadcast-send').on('click', async function() {
        const message = $('#broadcast-message').val().trim();
        const autoHide = $('#broadcast-auto-hide').is(':checked');
        
        if (!message) {
            toastr.warning('메시지를 입력해주세요.');
            return;
        }
        
        selectedChats = [];
        $('.broadcast-chat-checkbox:checked').each(function() {
            selectedChats.push({
                chatId: $(this).data('chat-id'),
                character: $(this).data('character'),
            });
        });
        
        if (selectedChats.length === 0) {
            toastr.warning('최소 하나의 채팅을 선택해주세요.');
            return;
        }
        
        // 설정 저장
        extension_settings[extensionName].autoHide = autoHide;
        saveSettingsDebounced();
        
        closeChatSelector();
        await broadcastMessage(message, autoHide);
    });
}

/**
 * 채팅 선택 UI 닫기
 */
function closeChatSelector() {
    $('#broadcast-modal').remove();
}

/**
 * 메시지 브로드캐스트 실행
 * @param {string} message 보낼 메시지
 * @param {boolean} autoHide 자동 숨김 여부
 */
async function broadcastMessage(message, autoHide) {
    if (isProcessing) {
        toastr.warning('이미 진행 중입니다.');
        return;
    }
    
    isProcessing = true;
    const delay = extension_settings[extensionName].delayBetweenChats;
    
    toastr.info(`${selectedChats.length}개의 채팅에 메시지를 전송합니다...`);
    
    let successCount = 0;
    let failCount = 0;
    
    for (const chat of selectedChats) {
        try {
            // 1. 해당 채팅으로 전환
            await switchToChat(chat.chatId, chat.character);
            
            // 2. 현재 메시지 수 기록 (숨김 처리를 위해)
            const currentMsgCount = $('#chat .mes').length;
            
            // 3. 자동 숨김 설정
            if (autoHide) {
                pendingHide.set(chat.chatId, {
                    startIndex: currentMsgCount,
                    waiting: true,
                });
            }
            
            // 4. 메시지 전송
            await sendMessage(message);
            
            successCount++;
            
            // 5. 다음 채팅 전 딜레이
            if (selectedChats.indexOf(chat) < selectedChats.length - 1) {
                await sleep(delay);
            }
        } catch (error) {
            console.error(`[Broadcast] Failed to send to ${chat.character}:`, error);
            failCount++;
        }
    }
    
    isProcessing = false;
    toastr.success(`전송 완료: 성공 ${successCount}, 실패 ${failCount}`);
}

/**
 * 채팅 전환
 * @param {string} chatId 채팅 ID
 * @param {string} characterName 캐릭터 이름
 */
async function switchToChat(chatId, characterName) {
    // SillyTavern의 채팅 전환 함수 호출
    // 실제 구현은 SillyTavern 버전에 따라 다를 수 있음
    
    const characterElement = $(`.character_select[chid]`).filter(function() {
        return $(this).find('.ch_name').text().trim() === characterName;
    });
    
    if (characterElement.length > 0) {
        characterElement.trigger('click');
        await sleep(500); // 채팅 로드 대기
    }
    
    // 특정 채팅 파일 로드가 필요한 경우
    // await loadChat(chatId);
}

/**
 * 메시지 전송
 * @param {string} message 메시지
 */
async function sendMessage(message) {
    const textarea = $('#send_textarea');
    textarea.val(message);
    
    // 전송 버튼 클릭 또는 Enter 이벤트 트리거
    $('#send_but').trigger('click');
    
    // 응답 대기 (간단한 방법)
    await waitForResponse();
}

/**
 * 응답 대기
 */
function waitForResponse() {
    return new Promise((resolve) => {
        const checkInterval = setInterval(() => {
            // 생성 중 표시가 사라지면 완료
            if (!$('#send_but').hasClass('disabled') && !$('.mes_generating').length) {
                clearInterval(checkInterval);
                resolve();
            }
        }, 500);
        
        // 타임아웃 (60초)
        setTimeout(() => {
            clearInterval(checkInterval);
            resolve();
        }, 60000);
    });
}

/**
 * 메시지 숨김 처리
 * @param {number} messageIndex 메시지 인덱스
 */
async function hideMessage(messageIndex) {
    try {
        // /hide 슬래시 커맨드 실행
        await SlashCommandParser.execute(`/hide ${messageIndex}`);
    } catch (error) {
        console.error('[Broadcast] Error hiding message:', error);
    }
}

/**
 * 응답 완료 시 자동 숨김 처리
 */
function handleMessageReceived() {
    // 현재 채팅 ID 확인
    const currentChatId = getCurrentChatId();
    
    if (pendingHide.has(currentChatId)) {
        const hideInfo = pendingHide.get(currentChatId);
        
        if (hideInfo.waiting) {
            hideInfo.waiting = false;
            
            // 마지막 2개 메시지 숨김 (보낸 메시지 + 응답)
            const messages = $('#chat .mes');
            const lastIndex = messages.length - 1;
            
            // 숨김 처리 (역순으로)
            setTimeout(async () => {
                await hideMessage(lastIndex);     // 응답
                await hideMessage(lastIndex - 1); // 보낸 메시지
                pendingHide.delete(currentChatId);
            }, 500);
        }
    }
}

/**
 * 현재 채팅 ID 가져오기
 */
function getCurrentChatId() {
    // SillyTavern의 현재 채팅 ID 반환
    // 실제 구현은 전역 변수나 API를 통해 가져와야 함
    return window.chat_file_name || 'unknown';
}

/**
 * 슬립 함수
 * @param {number} ms 밀리초
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 슬래시 커맨드 등록
 */
function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'broadcast',
        callback: async () => {
            await openChatSelector();
            return '';
        },
        helpString: '여러 채팅에 동일한 메시지를 전송하는 UI를 엽니다.',
    }));
}

/**
 * UI 버튼 추가
 */
function addUIButton() {
    const buttonHtml = `
        <div id="broadcast-button" class="list-group-item flex-container flexGap5" title="브로드캐스트 메시지">
            <div class="fa-solid fa-bullhorn extensionsMenuExtensionButton"></div>
            <span>브로드캐스트</span>
        </div>
    `;
    
    // 확장 메뉴에 버튼 추가
    $('#extensionsMenu').append(buttonHtml);
    $('#broadcast-button').on('click', openChatSelector);
}

/**
 * 확장 프로그램 초기화
 */
jQuery(async () => {
    console.log('[Broadcast] Extension loading...');
    
    // 설정 로드
    loadSettings();
    
    // UI 버튼 추가
    addUIButton();
    
    // 슬래시 커맨드 등록
    registerSlashCommands();
    
    // 메시지 수신 이벤트 리스너
    eventSource.on(event_types.MESSAGE_RECEIVED, handleMessageReceived);
    
    console.log('[Broadcast] Extension loaded successfully!');
});
