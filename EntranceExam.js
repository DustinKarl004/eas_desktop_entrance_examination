import { db, auth } from './firebase_config.js';
import { collection, getDocs, doc, getDoc, setDoc, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

let currentQuestion = 0;
let questions = [];
let currentSubject = '';
let userAnswers = {};
let currentUser = null;
let completedSubjects = [];
let subjectList = [];
let currentSubjectPage = 0;
let subjectsPerPage = 6;
let baseTimeLimit = 30 * 60; // Base 30 minute in seconds
let timeLimit = baseTimeLimit;
let bonusTime = 0; // Store bonus time from previous subjects
let timerInterval;
let timerElement;
let examStarted = false;
let examStartTime;
let examInProgress = false;
let examEndTime;

// Show loading overlay initially
const loadingOverlay = document.getElementById('loading-overlay');

// Disable right-click and copy
document.addEventListener('contextmenu', (e) => {
    if (examInProgress) {
        e.preventDefault();
    }
});

document.addEventListener('copy', (e) => {
    if (examInProgress) {
        e.preventDefault(); 
    }
});

// Check authentication state
onAuthStateChanged(auth, async (user) => {
    if (user) {
        currentUser = user;
        document.getElementById('user-email').textContent = user.email;

        // Get exam schedule for user
        try {
            const freshmenQuery = query(collection(db, 'freshmen_examinees'), where('email', '==', user.email));
            const transfereeQuery = query(collection(db, 'transferee_examinees'), where('email', '==', user.email));
            
            const [freshmenDocs, transfereeDocs] = await Promise.all([
                getDocs(freshmenQuery),
                getDocs(transfereeQuery)
            ]);

            let examineeData;
            if (!freshmenDocs.empty) {
                examineeData = freshmenDocs.docs[0].data();
            } else if (!transfereeDocs.empty) {
                examineeData = transfereeDocs.docs[0].data();
            }

            if (examineeData) {
                const today = new Date();
                const examDate = new Date(examineeData.examDate);
                const [endHour, endMinute] = examineeData.examEndTime.split(':');
                examEndTime = new Date(examDate);
                examEndTime.setHours(parseInt(endHour), parseInt(endMinute), 0);

                // If exam end time has passed, mark all as completed
                if (today > examEndTime) {
                    await loadSubjects();
                    // Mark all subjects as completed and unanswered questions as incorrect
                    for (const subject of subjectList) {
                        if (!completedSubjects.includes(subject.name.toLowerCase())) {
                            currentSubject = subject.name.toLowerCase();
                            // Load questions for this subject
                            const docRef = doc(db, "EntranceExamQuestion", currentSubject);
                            const docSnap = await getDoc(docRef);
                            if (docSnap.exists()) {
                                const questions = Object.keys(docSnap.data());
                                // Mark all questions as incorrect/unanswered
                                questions.forEach(qNum => {
                                    userAnswers[qNum] = "";
                                });
                            }
                            completedSubjects.push(currentSubject);
                            await saveUserAnswers();
                        }
                    }
                    showCompletionMessage();
                    loadingOverlay.style.display = 'none';
                    return;
                }

                // Check if current time is past end time
                if (today > examEndTime) {
                    // Mark remaining subjects as completed with incorrect answers
                    await loadSubjects();
                    for (const subject of subjectList) {
                        if (!completedSubjects.includes(subject.name.toLowerCase())) {
                            currentSubject = subject.name.toLowerCase();
                            const docRef = doc(db, "EntranceExamQuestion", currentSubject);
                            const docSnap = await getDoc(docRef);
                            if (docSnap.exists()) {
                                const questions = Object.keys(docSnap.data());
                                questions.forEach(qNum => {
                                    userAnswers[qNum] = ""; // Empty string for incorrect/unanswered
                                });
                            }
                            completedSubjects.push(currentSubject);
                            await saveUserAnswers();
                        }
                    }
                    await signOut(auth);
                    window.location.href = './login.html';
                    return;
                }

                // Set interval to check end time
                setInterval(async () => {
                    if (new Date() > examEndTime) {
                        // Mark remaining subjects as completed with incorrect answers
                        await loadSubjects();
                        for (const subject of subjectList) {
                            if (!completedSubjects.includes(subject.name.toLowerCase())) {
                                currentSubject = subject.name.toLowerCase();
                                const docRef = doc(db, "EntranceExamQuestion", currentSubject);
                                const docSnap = await getDoc(docRef);
                                if (docSnap.exists()) {
                                    const questions = Object.keys(docSnap.data());
                                    questions.forEach(qNum => {
                                        userAnswers[qNum] = ""; // Empty string for incorrect/unanswered
                                    });
                                }
                                completedSubjects.push(currentSubject);
                                await saveUserAnswers();
                            }
                        }
                        await signOut(auth);
                        window.location.href = './login.html'; 
                    }
                }, 1000);
            }
        } catch (error) {
            console.error("Error checking exam schedule:", error);
        }

        await loadSubjects();
        await loadUserProgress();
        await loadUserAnswers();
        
        // Check if all subjects are completed
        const allCompleted = subjectList.every(subject => completedSubjects.includes(subject.name.toLowerCase()));
        
        if (allCompleted) {
            showCompletionMessage();
        } else {
            // Mark any incomplete subjects with unanswered questions as incorrect
            for (const subject of subjectList) {
                if (!completedSubjects.includes(subject.name.toLowerCase())) {
                    const docRef = doc(db, "EntranceExamQuestion", subject.name.toLowerCase());
                    const docSnap = await getDoc(docRef);
                    if (docSnap.exists()) {
                        const questions = Object.keys(docSnap.data());
                        const userAnswersRef = doc(db, "EntranceExam", currentUser.email);
                        const userAnswersSnap = await getDoc(userAnswersRef);
                        const userAnswersData = userAnswersSnap.exists() ? userAnswersSnap.data() : {};
                        const subjectAnswers = userAnswersData[subject.name.toLowerCase()] || {};
                        
                        // Check if subject has any answers but is incomplete
                        if (Object.keys(subjectAnswers).length > 0 && 
                            Object.keys(subjectAnswers).length < questions.length) {
                            // Mark remaining questions as incorrect
                            questions.forEach(qNum => {
                                if (!subjectAnswers[qNum]) {
                                    subjectAnswers[qNum] = "";
                                }
                            });
                            // Save the updated answers
                            await setDoc(userAnswersRef, {
                                [subject.name.toLowerCase()]: subjectAnswers
                            }, { merge: true });
                        }
                        // If subject has no answers at all, mark all as incorrect
                        else if (Object.keys(subjectAnswers).length === 0) {
                            const emptyAnswers = {};
                            questions.forEach(qNum => {
                                emptyAnswers[qNum] = "";
                            });
                            await setDoc(userAnswersRef, {
                                [subject.name.toLowerCase()]: emptyAnswers
                            }, { merge: true });
                        }
                    }
                }
            }
            
            checkExamProgress();
            // Check if there's a saved timer state
            const savedTimerState = localStorage.getItem('examTimer');
            if (savedTimerState) {
                const {subject, startTime, timeRemaining, savedBonusTime} = JSON.parse(savedTimerState);
                if (subject === currentSubject) {
                    examStartTime = startTime;
                    timeLimit = timeRemaining;
                    bonusTime = savedBonusTime || 0;
                    examStarted = true;
                    examInProgress = true;
                    document.getElementById('logout-btn').disabled = true;
                    startExam();
                }
            }
        }
        
        // Hide loading overlay after everything is loaded
        loadingOverlay.style.display = 'none';
    } else {
        window.location.href = './login.html';
    }
});

function startCountdown() {
    // If there's no saved timer state, initialize it
    if (!examStartTime) {
        examStartTime = Date.now();
        timeLimit = baseTimeLimit + bonusTime; // Add bonus time to base time
    } else {
        // Calculate remaining time based on saved start time
        const elapsedTime = Math.floor((Date.now() - examStartTime) / 1000);
        timeLimit = Math.max(baseTimeLimit + bonusTime - elapsedTime, 0);
    }
    
    if (!timerElement) {
        timerElement = document.createElement('div');
        timerElement.id = 'timer';
        timerElement.style.cssText = 'font-size: 1.5rem; font-weight: bold; margin-bottom: 1rem; text-align: center;';
        document.querySelector('.question-container').insertBefore(timerElement, document.querySelector('.question-container .progress-container'));
    }

    // Clear existing interval if any
    if (timerInterval) {
        clearInterval(timerInterval);
    }

    // Show bonus time animation if there is bonus time
    if (bonusTime > 0) {
        timerElement.classList.add('bonus-time');
        setTimeout(() => {
            timerElement.classList.remove('bonus-time');
        }, 1000);
    }

    timerInterval = setInterval(() => {
        let minutes = Math.floor(timeLimit / 60);
        let seconds = timeLimit % 60;

        timerElement.textContent = `Time Remaining: ${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        if (bonusTime > 0) {
            timerElement.textContent += ` (+${Math.floor(bonusTime/60)}:${(bonusTime%60).toString().padStart(2, '0')} bonus)`;
        }

        // Save timer state to localStorage
        localStorage.setItem('examTimer', JSON.stringify({
            subject: currentSubject,
            startTime: examStartTime,
            timeRemaining: timeLimit,
            savedBonusTime: bonusTime
        }));

        if (timeLimit > 0) {
            timeLimit--;
        } else {
            clearInterval(timerInterval);
            localStorage.removeItem('examTimer');
            handleTimeOut();
        }
    }, 1000);
}

async function handleTimeOut() {
    examInProgress = false;
    // Mark all unanswered questions as incorrect
    questions.forEach((question, index) => {
        if (!userAnswers[question.questionNumber]) {
            userAnswers[question.questionNumber] = ""; // Empty string indicates unanswered/incorrect
        }
    });
    
    // Show timeout modal
    const timeoutModal = document.getElementById('timeout-modal');
    timeoutModal.style.display = 'flex';
    
    // Wait 2 seconds then automatically proceed
    setTimeout(async () => {
        timeoutModal.style.display = 'none';
        localStorage.removeItem('examTimer');
        bonusTime = 0; // Reset bonus time when time runs out
        await saveUserAnswers();
        await finishExam();
    }, 2000);
}

async function loadSubjects() {
    try {
        const querySnapshot = await getDocs(collection(db, "subjectlist"));
        subjectList = [];
        querySnapshot.forEach((doc) => {
            subjectList.push({
                id: doc.id,
                ...doc.data()
            });
        });

        // Sort subjects to ensure mathematics is first if it exists
        subjectList.sort((a, b) => {
            if(a.name.toLowerCase() === 'mathematics') return -1;
            if(b.name.toLowerCase() === 'mathematics') return 1;
            return 0;
        });

        // Set initial current subject
        if(subjectList.length > 0) {
            currentSubject = subjectList[0].name.toLowerCase();
        }

        updateSubjectListUI();

    } catch (error) {
        console.error("Error loading subjects:", error);
    }
}

function updateSubjectListUI() {
    const startIndex = currentSubjectPage * subjectsPerPage;
    const endIndex = startIndex + subjectsPerPage;
    const visibleSubjects = subjectList.slice(startIndex, endIndex);
    
    const subjectListElement = document.getElementById('subject-list');
    subjectListElement.innerHTML = visibleSubjects.map(subject => `
        <li class="subject-item ${subject.name.toLowerCase() === currentSubject ? 'active' : ''} 
            ${completedSubjects.includes(subject.name.toLowerCase()) ? 'completed' : ''}" 
            id="${subject.name.toLowerCase()}">
            ${subject.name} 
            ${subject.name.toLowerCase() === currentSubject && !completedSubjects.includes(subject.name.toLowerCase()) ? '<i class="fas fa-spinner fa-spin"></i>' : ''}
            ${completedSubjects.includes(subject.name.toLowerCase()) ? '<i class="fas fa-check-circle"></i>' : ''}
        </li>
    `).join('');
}

function checkExamProgress() {
    const startSection = document.getElementById('start-exam-section');
    const continueSection = document.getElementById('continue-exam-section');
    const remainingSubjectsDiv = document.getElementById('remaining-subjects');
    
    if (completedSubjects.length > 0) {
        startSection.style.display = 'none';
        continueSection.style.display = 'block';
        
        const remainingSubjects = subjectList.filter(subject => 
            !completedSubjects.includes(subject.name.toLowerCase())
        );
        
        remainingSubjectsDiv.innerHTML = remainingSubjects.map(subject => 
            `<div style="margin: 0.5rem 0;">
                • ${subject.name}
            </div>`
        ).join('');
    } else {
        startSection.style.display = 'block';
        continueSection.style.display = 'none';
    }
}

async function loadUserProgress() {
    if (!currentUser) return;
    
    try {
        const userDocRef = doc(db, "EntranceExam", currentUser.email);
        const userDocSnap = await getDoc(userDocRef);
        
        if (userDocSnap.exists()) {
            const data = userDocSnap.data();
            completedSubjects = data.completedSubjects || [];
            
            // Find first incomplete subject
            const nextSubject = subjectList.find(subject => 
                !completedSubjects.includes(subject.name.toLowerCase())
            );
            
            if (nextSubject) {
                currentSubject = nextSubject.name.toLowerCase();
            }
            
            updateSubjectListUI();
        }
    } catch (error) {
        console.error("Error loading user progress:", error);
    }
}

async function loadUserAnswers() {
    if (!currentUser) return;
    
    try {
        const userDocRef = doc(db, "EntranceExam", currentUser.email);
        const userDocSnap = await getDoc(userDocRef);
        
        if (userDocSnap.exists()) {
            const data = userDocSnap.data();
            if (data[currentSubject]) {
                userAnswers = data[currentSubject];
            }
        }
    } catch (error) {
        console.error("Error loading user answers:", error);
    }
}

async function saveUserAnswers() {
    if (!currentUser) return;
    
    try {
        const userDocRef = doc(db, "EntranceExam", currentUser.email);
        const userDocSnap = await getDoc(userDocRef);
        
        let updatedData = {};
        if (userDocSnap.exists()) {
            updatedData = userDocSnap.data();
        }
        
        updatedData[currentSubject] = userAnswers;
        updatedData.completedSubjects = completedSubjects;
        
        await setDoc(userDocRef, updatedData, { merge: true });
    } catch (error) {
        console.error("Error saving user answers:", error);
    }
}

function showCompletionMessage() {
    examInProgress = false;
    document.getElementById('questionnaire-content').innerHTML = `
        <div class="instruction-container">
            <h3>Entrance Exam Completed</h3>
            <p>Congratulations! You have completed all sections of the entrance exam.</p>
            <p>Your responses have been recorded.</p>
        </div>
    `;
    // Hide loading overlay and spinner when exam is complete
    loadingOverlay.style.display = 'none';
    examStarted = false;
    document.getElementById('logout-btn').disabled = false;
    document.getElementById('logout-btn').style.display = 'block';
    localStorage.removeItem('examTimer');
}

window.logout = async function() {
    if (examStarted) {
        alert("You cannot logout while the exam is in progress!");
        return;
    }
    try {
        await signOut(auth);
        localStorage.removeItem('examTimer');
        window.location.href = './login.html';
    } catch (error) {
        console.error("Error signing out:", error);
    }
}

window.checkAuthAndStartExam = function() {
    if (!currentUser) {
        const content = document.getElementById('questionnaire-content');
        content.innerHTML = `
            <div class="auth-error">
                Please log in to start the exam.
            </div>
        `;
        return;
    }
    
    if (completedSubjects.includes(currentSubject)) {
        const content = document.getElementById('questionnaire-content');
        content.innerHTML = `
            <div class="instruction-container">
                <h3>Subject Already Completed</h3>
                <p>You have already completed the ${currentSubject} section.</p>
            </div>
        `;
        return;
    }
    
    examStarted = true;
    examInProgress = true;
    document.getElementById('logout-btn').disabled = true;
    document.getElementById('logout-btn').style.display = 'none';
    startExam();
}

window.startExam = async function() {
    try {
        const docRef = doc(db, "EntranceExamQuestion", currentSubject);
        const docSnap = await getDoc(docRef);
        
        if (docSnap.exists()) {
            // Get all questions and assign random order numbers
            questions = Object.entries(docSnap.data()).map(([num, data]) => ({
                ...data,
                questionNumber: num,
                randomOrder: Math.random() // Add random order value
            }));
            
            // Sort by random order
            questions.sort((a, b) => a.randomOrder - b.randomOrder);
            
            // Remove the random order property as it's no longer needed
            questions = questions.map(({randomOrder, ...rest}) => rest);
            
            showQuestion(0);
            startCountdown();
        }
    } catch (error) {
        console.error("Error loading questions:", error);
    }
}

function showQuestion(index) {
    const content = document.getElementById('questionnaire-content');
    const question = questions[index];
    const progress = ((index + 1) / questions.length) * 100;
    
    let navigationButtons = '';
    if (index === 0) {
        navigationButtons = '<button class="nav-button" onclick="validateAndNext()">Next</button>';
    } else if (index === questions.length - 1) {
        navigationButtons = `
            <button class="nav-button" onclick="previousQuestion()">Back</button>
            <button class="nav-button" onclick="validateAndFinish()">Finish</button>
        `;
    } else {
        navigationButtons = `
            <button class="nav-button" onclick="previousQuestion()">Back</button>
            <button class="nav-button" onclick="validateAndNext()">Next</button>
        `;
    }

    content.innerHTML = `
        <div class="question-container">
            <div class="progress-container">
                <div class="progress-bar" style="width: ${progress}%">
                    <div class="progress-text">${Math.round(progress)}%</div>
                </div>
            </div>
            <p>${question.question}</p>
            <div class="error-message" id="error-message">
                Please select an answer before proceeding
            </div>
            <div class="options-container">
                ${Object.entries(question.options).map(([key, value]) => `
                    <div class="option-item">
                        <input type="radio" name="answer" value="${key}" id="option${key}" 
                            ${userAnswers[question.questionNumber] === key ? 'checked' : ''}>
                        <label for="option${key}">${value}</label>
                    </div>
                `).join('')}
            </div>
            <div class="navigation">
                ${navigationButtons}
            </div>
        </div>
    `;

    // Preserve timer element when showing new question
    if (timerElement) {
        document.querySelector('.question-container').insertBefore(timerElement, document.querySelector('.question-container .progress-container'));
    }
}

window.validateAndNext = async function() {
    const selectedAnswer = document.querySelector('input[name="answer"]:checked');
    const errorMessage = document.getElementById('error-message');
    const nextButton = document.querySelector('button.nav-button:last-child');
    
    if (!selectedAnswer) {
        errorMessage.style.display = 'block';
        return;
    }
    
    errorMessage.style.display = 'none';
    nextButton.classList.add('loading');
    
    userAnswers[questions[currentQuestion].questionNumber] = selectedAnswer.value;
    await saveUserAnswers();

    currentQuestion++;
    showQuestion(currentQuestion);
}

window.validateAndFinish = async function() {
    const selectedAnswer = document.querySelector('input[name="answer"]:checked');
    const errorMessage = document.getElementById('error-message');
    const finishButton = document.querySelector('button.nav-button:last-child');
    
    if (!selectedAnswer) {
        errorMessage.style.display = 'block';
        return;
    }
    
    errorMessage.style.display = 'none';
    finishButton.classList.add('loading');
    
    userAnswers[questions[currentQuestion].questionNumber] = selectedAnswer.value;
    clearInterval(timerInterval);
    localStorage.removeItem('examTimer');
    await saveUserAnswers();
    await finishExam();
}

window.previousQuestion = function() {
    currentQuestion--;
    showQuestion(currentQuestion);
}

window.startNextSubject = function(subject) {
    if (completedSubjects.includes(subject)) {
        const content = document.getElementById('questionnaire-content');
        content.innerHTML = `
            <div class="instruction-container">
                <h3>Subject Already Completed</h3>
                <p>You have already completed the ${subject} section.</p>
            </div>
        `;
        return;
    }
    
    currentSubject = subject;
    currentQuestion = 0;
    userAnswers = {};
    timerElement = null;
    examStartTime = null;
    localStorage.removeItem('examTimer');
    
    updateSubjectListUI();
    loadUserAnswers().then(() => startExam());
}


async function finishExam() {
    examInProgress = false;
    // Calculate remaining time as bonus for next subject
    if (timeLimit > 0) {
        bonusTime = timeLimit;
    }

    completedSubjects.push(currentSubject);
    await saveUserAnswers();
    
    updateSubjectListUI();
    
    const nextSubject = subjectList.find(subject => 
        !completedSubjects.includes(subject.name.toLowerCase())
    );

    if (nextSubject) {
        // Automatically start next subject
        currentSubject = nextSubject.name.toLowerCase();
        currentQuestion = 0;
        userAnswers = {};
        timerElement = null;
        examStartTime = null;
        localStorage.removeItem('examTimer');
        updateSubjectListUI();
        await loadUserAnswers();
        startExam();
    } else {
        showCompletionMessage();
        examStarted = false;
        document.getElementById('logout-btn').disabled = false;
        document.getElementById('logout-btn').style.display = 'block';
        bonusTime = 0; // Reset bonus time when exam is complete
    }
}   