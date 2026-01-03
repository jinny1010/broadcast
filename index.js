// Broadcast Message Extension for SillyTavern
// 여러 채팅에 동일한 메시지를 보내고 자동으로 숨김 처리

import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    getRequestHeaders,
    chat,
} from '../../../../script.js';

import { extension_settings } from '../../../extensions.js';

const extensionName = 'broadcast-message';

// 기본 설정
const defaultSettings = {
    autoHide: true,
    delayBetweenChats: 2000,
};

// 상태 관리
let isProcessing = false;
let selectedChats = [];
let pendingHide = new Map();

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
    
    $('body').append(modalHtml);
    
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
 * 하이드 개수 입력 모달 열기
 */
function openHideModal() {
    const modalHtml = `
        <div id="hide-modal" class="broadcast-modal">
            <div class="broadcast-modal-content" style="max-width: 300px;">
                <h3>🙈 메시지 숨기기</h3>
                
                <div class="broadcast-message-input">
                    <label for="hide-count">숨길 메시지 개수:</label>
                    <input type="number" id="hide-count" min="1" max="100" value="2" 
                           style="width: 100%; padding: 10px; border-radius: 5px; border: 1px solid var(--SmartThemeBorderColor, #444); background: var(--SmartThemeBlurTintColor, #0d0d1a); color: var(--SmartThemeBodyColor, #fff);">
                    <small style="color: #888; margin-top: 5px; display: block;">마지막 메시지부터 숨깁니다</small>
                </div>
                
                <div class="broadcast-actions">
                    <button id="hide-cancel" class="menu_button">취소</button>
                    <button id="hide-confirm" class="menu_button">숨기기</button>
                </div>
            </div>
        </div>
    `;
    
    $('body').append(modalHtml);
    
    $('#hide-count').focus().select();
    
    $('#hide-cancel').on('click', () => $('#hide-modal').remove());
    
    $('#hide-confirm').on('click', async function() {
        const count = parseInt($('#hide-count').val(), 10);
        
        if (isNaN(count) || count < 1) {
            toastr.warning('올바른 숫자를 입력해주세요.');
            return;
        }
        
        $('#hide-modal').remove();
        await hideLastMessages(count);
    });
    
    // Enter 키로 확인
    $('#hide-count').on('keypress', function(e) {
        if (e.which === 13) {
            $('#hide-confirm').click();
        }
    });
}

/**
 * 마지막 N개 메시지 숨기기
 */
async function hideLastMessages(count) {
    const messages = $('#chat .mes:not(.hidden-message)');
    const totalMessages = messages.length;
    
    if (totalMessages === 0) {
        toastr.info('숨길 메시지가 없습니다.');
        return;
    }
    
    const hideCount = Math.min(count, totalMessages);
    
    toastr.info(`마지막 ${hideCount}개 메시지를 숨기는 중...`);
    
    // 마지막 메시지부터 역순으로 숨김
    for (let i = 0; i < hideCount; i++) {
        const msgIndex = totalMessages - 1 - i;
        await hideMessageByIndex(msgIndex);
        await sleep(100); // 약간의 딜레이
    }
    
    toastr.success(`${hideCount}개 메시지를 숨겼습니다.`);
}

/**
 * 인덱스로 메시지 숨기기
 */
async function hideMessageByIndex(index) {
    try {
        // chat 배열에서 해당 메시지의 is_hidden을 true로 설정
        if (chat && chat[index]) {
            chat[index].is_hidden = true;
            
            // UI 업데이트
            const messageElement = $(`#chat .mes[mesid="${index}"]`);
            if (messageElement.length) {
                messageElement.addClass('hidden-message');
                messageElement.attr('is_hidden', 'true');
            }
        }
    } catch (error) {
        console.error('[Broadcast] Error hiding message:', error);
    }
}

/**
 * 메시지 브로드캐스트 실행
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
    
    for (const chatInfo of selectedChats) {
        try {
            await switchToChat(chatInfo.chatId, chatInfo.character);
            
            const currentMsgCount = $('#chat .mes').length;
            
            if (autoHide) {
                pendingHide.set(chatInfo.chatId, {
                    startIndex: currentMsgCount,
                    waiting: true,
                });
            }
            
            await sendMessage(message);
            
            successCount++;
            
            if (selectedChats.indexOf(chatInfo) < selectedChats.length - 1) {
                await sleep(delay);
            }
        } catch (error) {
            console.error(`[Broadcast] Failed to send to ${chatInfo.character}:`, error);
            failCount++;
        }
    }
    
    isProcessing = false;
    toastr.success(`전송 완료: 성공 ${successCount}, 실패 ${failCount}`);
}

/**
 * 채팅 전환
 */
async function switchToChat(chatId, characterName) {
    const characterElement = $(`.character_select[chid]`).filter(function() {
        return $(this).find('.ch_name').text().trim() === characterName;
    });
    
    if (characterElement.length > 0) {
        characterElement.trigger('click');
        await sleep(500);
    }
}

/**
 * 메시지 전송
 */
async function sendMessage(message) {
    const textarea = $('#send_textarea');
    textarea.val(message);
    $('#send_but').trigger('click');
    await waitForResponse();
}

/**
 * 응답 대기
 */
function waitForResponse() {
    return new Promise((resolve) => {
        const checkInterval = setInterval(() => {
            if (!$('#send_but').hasClass('disabled') && !$('.mes_generating').length) {
                clearInterval(checkInterval);
                resolve();
            }
        }, 500);
        
        setTimeout(() => {
            clearInterval(checkInterval);
            resolve();
        }, 60000);
    });
}

/**
 * 응답 완료 시 자동 숨김 처리
 */
function handleMessageReceived() {
    const currentChatId = getCurrentChatId();
    
    if (pendingHide.has(currentChatId)) {
        const hideInfo = pendingHide.get(currentChatId);
        
        if (hideInfo.waiting) {
            hideInfo.waiting = false;
            
            const messages = $('#chat .mes');
            const lastIndex = messages.length - 1;
            
            setTimeout(async () => {
                await hideMessageByIndex(lastIndex);
                await hideMessageByIndex(lastIndex - 1);
                pendingHide.delete(currentChatId);
            }, 500);
        }
    }
}

/**
 * 현재 채팅 ID 가져오기
 */
function getCurrentChatId() {
    return window.chat_file_name || 'unknown';
}

/**
 * 슬립 함수
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 하단 버튼 영역에 버튼 추가
 */
function addBottomButtons() {
    // 버튼 HTML - 입력창 왼쪽 버튼 영역에 추가
    const broadcastBtnHtml = `
        <div id="broadcast-btn" class="fa-solid fa-bullhorn interactable" 
             title="브로드캐스트" 
             style="cursor: pointer; padding: 5px; font-size: 16px;"></div>
    `;
    
    const hideBtnHtml = `
        <div id="hide-btn" class="fa-solid fa-eye-slash interactable" 
             title="메시지 숨기기" 
             style="cursor: pointer; padding: 5px; font-size: 16px;"></div>
    `;
    
    // 입력창 왼쪽 영역에 버튼 추가 (다양한 위치 시도)
    const targetSelectors = [
        '#leftSendForm',
        '#send_form .send_form_buttons_left',
        '#send_form',
        '.send_form_buttons',
        '#data_bank_wand_container',
    ];
    
    let buttonsAdded = false;
    
    for (const selector of targetSelectors) {
        const target = $(selector);
        if (target.length > 0) {
            // 컨테이너 생성
            const container = $(`
                <div id="broadcast-buttons-container" style="display: flex; gap: 5px; align-items: center; margin-right: 5px;">
                    ${broadcastBtnHtml}
                    ${hideBtnHtml}
                </div>
            `);
            
            if (selector === '#send_form') {
                target.prepend(container);
            } else {
                target.append(container);
            }
            
            buttonsAdded = true;
            console.log('[Broadcast] Buttons added to:', selector);
            break;
        }
    }
    
    // 버튼이 추가되지 않았다면 body에 플로팅 버튼으로 추가
    if (!buttonsAdded) {
        const floatingHtml = `
            <div id="broadcast-floating-buttons" style="
                position: fixed;
                bottom: 80px;
                left: 10px;
                display: flex;
                flex-direction: column;
                gap: 10px;
                z-index: 1000;
            ">
                <div id="broadcast-btn" class="fa-solid fa-bullhorn" 
                     title="브로드캐스트" 
                     style="cursor: pointer; padding: 10px; font-size: 18px; 
                            background: var(--SmartThemeBlurTintColor, #333); 
                            border-radius: 50%; 
                            border: 1px solid var(--SmartThemeBorderColor, #444);"></div>
                <div id="hide-btn" class="fa-solid fa-eye-slash" 
                     title="메시지 숨기기" 
                     style="cursor: pointer; padding: 10px; font-size: 18px; 
                            background: var(--SmartThemeBlurTintColor, #333); 
                            border-radius: 50%; 
                            border: 1px solid var(--SmartThemeBorderColor, #444);"></div>
            </div>
        `;
        $('body').append(floatingHtml);
        console.log('[Broadcast] Floating buttons added');
    }
    
    // 이벤트 바인딩
    $(document).on('click', '#broadcast-btn', openChatSelector);
    $(document).on('click', '#hide-btn', openHideModal);
}

/**
 * 확장 프로그램 초기화
 */
jQuery(async () => {
    console.log('[Broadcast] Extension loading...');
    
    loadSettings();
    
    // DOM이 완전히 로드된 후 버튼 추가
    setTimeout(() => {
        addBottomButtons();
    }, 1000);
    
    eventSource.on(event_types.MESSAGE_RECEIVED, handleMessageReceived);
    
    console.log('[Broadcast] Extension loaded successfully!');
});
